/// <reference types="@webgpu/types" />
import init, { generate_units_v2 } from './pkg/casshern_sim';
import { runTests } from './test';

// ============================
// 定数
// ============================
// ============================
// 定数 (Defaults)
// ============================
// マップサイズ等はURLパラメータから取得するため変数化

// ============================
// シェーダーコード - グリッド構築
// ============================
const GRID_BUILD_SHADER = `
struct UnitData {
    pos: vec2<f32>,
    vel: vec2<f32>,
    hp: i32,
    state: u32,
    faction: u32,
    rank: u32,
    squad_id: u32,
    morale: f32,
    weapon_id: u32,
    _pad1: u32,
    _pad2: vec4<u32>,
}

struct GridUniforms {
    grid_cols: u32,
    grid_rows: u32,
    cell_size: f32,
    num_units: u32,
    max_per_cell: u32,
    _pad: vec3<u32>,
}

@group(0) @binding(0) var<storage, read> units: array<UnitData>;
@group(0) @binding(1) var<uniform> grid_uniforms: GridUniforms;
@group(0) @binding(2) var<storage, read_write> grid_counts: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> grid_cells: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= grid_uniforms.num_units) {
        return;
    }
    
    let unit = units[index];
    if (unit.state == 0u) {
        return; // 死亡ユニットはスキップ
    }
    
    // グリッドセル計算
    let cell_x = u32(clamp(unit.pos.x / grid_uniforms.cell_size, 0.0, f32(grid_uniforms.grid_cols - 1u)));
    let cell_y = u32(clamp(unit.pos.y / grid_uniforms.cell_size, 0.0, f32(grid_uniforms.grid_rows - 1u)));
    let cell_idx = cell_y * grid_uniforms.grid_cols + cell_x;
    
    // セル内の空きスロットを取得
    let slot = atomicAdd(&grid_counts[cell_idx], 1u);
    if (slot < grid_uniforms.max_per_cell) {
        let storage_idx = cell_idx * grid_uniforms.max_per_cell + slot;
        grid_cells[storage_idx] = index;
    }
}
`;

// ============================
// シェーダーコード - AIロジック（グリッドベース）
// ============================
const COMPUTE_SHADER = `
struct UnitData {
    pos: vec2<f32>,
    vel: vec2<f32>,
    hp: i32,
    state: u32,
    faction: u32,
    rank: u32,
    squad_id: u32,
    morale: f32,
    weapon_id: u32,
    _pad1: u32,
    _pad2: vec4<u32>,
}

struct GlobalUniforms {
    delta_time: f32,
    tick: u32,
    ai_interval: u32,
    human_phase: u32,
    casshern_mode: u32,
    player_input: u32,
    player_target_x: f32,
    player_target_y: f32,
    map_width: f32,
    map_height: f32,
    num_units: u32,
    vision_range: f32,
    andro_dmg: i32,
    human_dmg: i32,
    human_speed_ratio: f32,
    weapon_interval: u32,
}

struct GridUniforms {
    grid_cols: u32,
    grid_rows: u32,
    cell_size: f32,
    num_units: u32,
    max_per_cell: u32,
    _pad: vec3<u32>,
}

@group(0) @binding(0) var<storage, read_write> units: array<UnitData>;
@group(0) @binding(1) var<uniform> globals: GlobalUniforms;
@group(0) @binding(2) var<uniform> grid_uniforms: GridUniforms;
@group(0) @binding(3) var<storage, read> grid_counts: array<u32>; // read-only access to atomic buffer content
@group(0) @binding(4) var<storage, read> grid_cells: array<u32>;
@group(0) @binding(5) var<storage, read_write> damage_buffer: array<atomic<i32>>;

fn distance_sq(a: vec2<f32>, b: vec2<f32>) -> f32 {
    let d = a - b;
    return dot(d, d);
}

fn normalize_vec(v: vec2<f32>) -> vec2<f32> {
    let len = length(v);
    if (len < 0.001) { return vec2<f32>(0.0, 0.0); }
    return v / len;
}

// 擬似乱数生成
fn rand(co: vec2<f32>) -> f32 {
    return fract(sin(dot(co, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// 敵を探し、そのインデックスを返す（見つからない場合は -1）
fn find_nearest_enemy_grid(my_idx: u32, my_faction: u32, my_pos: vec2<f32>) -> i32 {
    var nearest_dist_sq: f32 = 999999.0;
    var nearest_idx: i32 = -1;
    
    let vision_range_sq: f32 = globals.vision_range * globals.vision_range;
    
    let cell_x = i32(my_pos.x / grid_uniforms.cell_size);
    let cell_y = i32(my_pos.y / grid_uniforms.cell_size);
    
    let search_radius = 1;
    
    for (var dy: i32 = -search_radius; dy <= search_radius; dy++) {
        for (var dx: i32 = -search_radius; dx <= search_radius; dx++) {
            let nx = cell_x + dx;
            let ny = cell_y + dy;
            
            if (nx < 0 || nx >= i32(grid_uniforms.grid_cols) || 
                ny < 0 || ny >= i32(grid_uniforms.grid_rows)) {
                continue;
            }
            
            let cell_idx = u32(ny) * grid_uniforms.grid_cols + u32(nx);
            let count = min(grid_counts[cell_idx], grid_uniforms.max_per_cell);
            let base_idx = cell_idx * grid_uniforms.max_per_cell;
            
            for (var i: u32 = 0u; i < count; i++) {
                let other_idx = grid_cells[base_idx + i];
                if (other_idx == my_idx) { continue; }
                
                let other = units[other_idx];
                if (other.state == 0u) { continue; }
                if (other.faction == my_faction) { continue; }
                
                // 人類(1)はキャシャーン(2)を敵とみなさない（味方）
                if (my_faction == 1u && other.faction == 2u) { continue; }
                
                let dist_sq = distance_sq(my_pos, other.pos);
                if (dist_sq < vision_range_sq && dist_sq < nearest_dist_sq) {
                    nearest_dist_sq = dist_sq;
                    nearest_idx = i32(other_idx);
                }
            }
        }
    }
    
    return nearest_idx;
}

// 全人類探索（ボス用）
fn find_human_global(my_pos: vec2<f32>) -> i32 {
    var nearest_dist_sq: f32 = 999999999.0;
    var nearest_idx: i32 = -1;
    for (var i: u32 = 0u; i < globals.num_units; i++) {
        let other = units[i];
        if (other.state == 0u || other.faction != 1u) { continue; }
        let dist_sq = distance_sq(my_pos, other.pos);
        if (dist_sq < nearest_dist_sq) {
            nearest_dist_sq = dist_sq;
            nearest_idx = i32(i);
        }
    }
    return nearest_idx;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= globals.num_units) {
        return;
    }

    var unit = units[index];

    if (unit.state == 0u) {
        return;
    }

    // キャシャーン（faction 2）は専用パス（CASSHERN_SHADER）で処理する。
    // 大衆パスでは被ダメージの適用と死亡判定のみを行う（移動・攻撃は専用パス側）。
    if (unit.faction == 2u) {
        let received = atomicExchange(&damage_buffer[index], 0);
        if (received > 0) {
            unit.hp -= received;
        }
        if (unit.hp <= 0) {
            unit.state = 0u;
            unit.hp = 0;
        }
        units[index] = unit;
        return;
    }

    let dt = globals.delta_time;
    let base_speed: f32 = 50.0;

    // AI更新（間隔制御 + 分散）
    let initial_delay = 60u;
    let should_update_ai = (globals.tick > initial_delay) && ((globals.tick + index) % globals.ai_interval == 0u);

    if (should_update_ai) {
        // 自律的装備変更 (1%の確率で装備を見直す)
        let rnd = rand(vec2<f32>(f32(index), f32(globals.tick)));
        if (rnd < 0.01) {
            var max_weapon = 0u;
            if (globals.tick > globals.weapon_interval * 3u) { max_weapon = 3u; }      // Melee
            else if (globals.tick > globals.weapon_interval * 2u) { max_weapon = 2u; } // Sniper
            else if (globals.tick > globals.weapon_interval) { max_weapon = 1u; }  // Spread
            
            // ランダムに選択 (0 ~ max_weapon)
            let weapon_choice = u32(rand(vec2<f32>(f32(index), f32(globals.tick) + 1.0)) * f32(max_weapon + 1u));
            unit.weapon_id = weapon_choice;
        }

        var enemy_idx: i32 = -1;

        enemy_idx = find_nearest_enemy_grid(index, unit.faction, unit.pos);

        // ボス(Rank>=2)かつ敵が見つからない場合は全探索
        if (enemy_idx == -1 && unit.faction == 0u && unit.rank >= 2u) {
            enemy_idx = find_human_global(unit.pos);
        }
        
        if (enemy_idx != -1) {
            let enemy = units[enemy_idx];
            let enemy_pos = enemy.pos;
            let dir = normalize_vec(enemy_pos - unit.pos);
            let dist = sqrt(distance_sq(enemy_pos, unit.pos));
            
            // 武器パラメータ設定
            var range = 20.0;
            var damage = 10;
            
            if (unit.faction == 0u) {
                damage = globals.andro_dmg;
            } else if (unit.faction == 1u) {
                damage = globals.human_dmg;
            }

            if (unit.weapon_id == 1u) {      // Spread
                range = 15.0;
                damage = damage * 2 / 3;
            } else if (unit.weapon_id == 2u) { // Sniper
                range = 60.0;
            } else if (unit.weapon_id == 3u) { // Melee
                range = 5.0;
                damage = damage * 5;
            }
            
            // 攻撃判定
            if (dist < range) {
                // ダメージ適用 (Atomic)
                atomicAdd(&damage_buffer[enemy_idx], damage);
            }
            
            if (unit.faction == 0u) {
                // アンドロ: 突撃
                unit.vel = dir * base_speed;
            }
            else if (unit.faction == 1u) {
                // 人類: フェーズに応じて
                if (globals.human_phase == 0u) {
                    unit.vel = -dir * base_speed * globals.human_speed_ratio; // 逃げる
                }
                else if (globals.human_phase == 1u) {
                    if (dist < 100.0) {
                        unit.vel = -dir * base_speed * globals.human_speed_ratio;
                    } else {
                        unit.vel = dir * base_speed * globals.human_speed_ratio;
                    }
                }
                else {
                    unit.vel = dir * base_speed * globals.human_speed_ratio; // 突撃
                }
            }
        }
        // 敵が見つからない場合は速度を維持（慣性で動く）
    } // should_update_ai end
            
    // 壁際での跳ね返りを優先
    let margin = 20.0;
    if (unit.pos.x < margin && unit.vel.x > 0.0) { unit.vel.x = abs(unit.vel.x); }
    if (unit.pos.x > globals.map_width - margin && unit.vel.x < 0.0) { unit.vel.x = -abs(unit.vel.x); }
    if (unit.pos.y < margin && unit.vel.y > 0.0) { unit.vel.y = abs(unit.vel.y); }
    if (unit.pos.y > globals.map_height - margin && unit.vel.y < 0.0) { unit.vel.y = -abs(unit.vel.y); }
    
    // 位置更新
    unit.pos += unit.vel * dt;
    
    // 境界チェック
    if (unit.pos.x < 0.0) { unit.pos.x = 0.0; unit.vel.x *= -1.0; }
    if (unit.pos.x > globals.map_width) { unit.pos.x = globals.map_width; unit.vel.x *= -1.0; }
    if (unit.pos.y < 0.0) { unit.pos.y = 0.0; unit.vel.y *= -1.0; }
    if (unit.pos.y > globals.map_height) { unit.pos.y = globals.map_height; unit.vel.y *= -1.0; }

    // HP更新とダメージ軽減
    let damage = atomicExchange(&damage_buffer[index], 0);
    if (damage > 0) {
        var actual_damage = damage;
        // キャシャーンのダメージ軽減削除 (HPで調整)
        // if (unit.faction == 2u) { actual_damage = damage / 5; }
        unit.hp -= actual_damage;
    }
    
    if (unit.hp <= 0) {
            unit.state = 0u; // 死亡
            unit.hp = 0;
        }
    

    units[index] = unit;
}
`;

// ============================
// シェーダーコード - キャシャーン専用AI（単体dispatch）
// ============================
// 設計メモ:
// - キャシャーンは全ユニット中ただ1体。彼だけを専用dispatch（workgroup 1本）で
//   処理することで、大衆シェーダから faction==2 分岐を消し、彼の側では
//   ロック／ヒステリシス等の状態機械を素直に書けるようにする。
// - 状態（ロック中の対象など）は CasshernState バッファに保持する。
//   モード切替時のリセットは CPU（JS）側が writeBuffer で行う。
// - 探索はすべて units 配列のシーケンシャルな全走査（リダクション）。
//   ランダムアクセスはロック対象の参照（O(1)）のみ。
const CASSHERN_SHADER = `
struct UnitData {
    pos: vec2<f32>,
    vel: vec2<f32>,
    hp: i32,
    state: u32,
    faction: u32,
    rank: u32,
    squad_id: u32,
    morale: f32,
    weapon_id: u32,
    _pad1: u32,
    _pad2: vec4<u32>,
}

struct GlobalUniforms {
    delta_time: f32,
    tick: u32,
    ai_interval: u32,
    human_phase: u32,
    casshern_mode: u32,
    player_input: u32,
    player_target_x: f32,
    player_target_y: f32,
    map_width: f32,
    map_height: f32,
    num_units: u32,
    vision_range: f32,
    andro_dmg: i32,
    human_dmg: i32,
    human_speed_ratio: f32,
    weapon_interval: u32,
}

struct CasshernState {
    lock_enemy: i32,      // 殲滅: ロック中の敵
    lock_boss: i32,       // 突撃: ロック中のボス (rank>=2)
    guard_human: i32,     // 援護: 護衛対象の人類
    engage_enemy: i32,    // 援護: 迎撃中の敵
    engaging: u32,        // 援護: 迎撃中フラグ (0/1)
    assault_contact: u32, // 突撃: ボスと接触中フラグ (0/1)
    _pad1: u32,
    _pad2: u32,
}

@group(0) @binding(0) var<storage, read_write> units: array<UnitData>;
@group(0) @binding(1) var<uniform> globals: GlobalUniforms;
@group(0) @binding(2) var<storage, read_write> cstate: CasshernState;
@group(0) @binding(3) var<storage, read_write> damage_buffer: array<atomic<i32>>;

fn distance_sq(a: vec2<f32>, b: vec2<f32>) -> f32 {
    let d = a - b;
    return dot(d, d);
}

fn normalize_vec(v: vec2<f32>) -> vec2<f32> {
    let len = length(v);
    if (len < 0.001) { return vec2<f32>(0.0, 0.0); }
    return v / len;
}

fn rand(co: vec2<f32>) -> f32 {
    return fract(sin(dot(co, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

fn is_valid_target(idx: i32, faction: u32) -> bool {
    if (idx < 0) { return false; }
    let u = units[u32(idx)];
    return u.state != 0u && u.faction == faction;
}

// from_pos に一番近いアンドロ（全走査）
fn scan_nearest_andro(my_idx: u32, from_pos: vec2<f32>) -> i32 {
    var nearest_dist_sq: f32 = 999999999.0;
    var nearest_idx: i32 = -1;
    for (var i: u32 = 0u; i < globals.num_units; i++) {
        if (i == my_idx) { continue; }
        let other = units[i];
        if (other.state == 0u || other.faction != 0u) { continue; }
        let dist_sq = distance_sq(from_pos, other.pos);
        if (dist_sq < nearest_dist_sq) {
            nearest_dist_sq = dist_sq;
            nearest_idx = i32(i);
        }
    }
    return nearest_idx;
}

// 一番近いボス（rank>=2 のみ。四天王とブロッケンJr）
fn scan_nearest_boss(from_pos: vec2<f32>) -> i32 {
    var nearest_dist_sq: f32 = 999999999.0;
    var nearest_idx: i32 = -1;
    for (var i: u32 = 0u; i < globals.num_units; i++) {
        let other = units[i];
        if (other.state == 0u || other.faction != 0u || other.rank < 2u) { continue; }
        let dist_sq = distance_sq(from_pos, other.pos);
        if (dist_sq < nearest_dist_sq) {
            nearest_dist_sq = dist_sq;
            nearest_idx = i32(i);
        }
    }
    return nearest_idx;
}

// アンドロ軍団の重心。敵が居なければ (-1, -1)
fn scan_andro_centroid() -> vec2<f32> {
    var sum = vec2<f32>(0.0, 0.0);
    var count: f32 = 0.0;
    for (var i: u32 = 0u; i < globals.num_units; i++) {
        let other = units[i];
        if (other.state == 0u || other.faction != 0u) { continue; }
        sum = sum + other.pos;
        count = count + 1.0;
    }
    if (count > 0.0) {
        return sum / count;
    }
    return vec2<f32>(-1.0, -1.0);
}

// 重心（＝敵軍の中心）に一番近い人類 ＝ 前線の人類
fn scan_frontline_human(centroid: vec2<f32>) -> i32 {
    var nearest_dist_sq: f32 = 999999999.0;
    var nearest_idx: i32 = -1;
    for (var i: u32 = 0u; i < globals.num_units; i++) {
        let other = units[i];
        if (other.state == 0u || other.faction != 1u) { continue; }
        let dist_sq = distance_sq(centroid, other.pos);
        if (dist_sq < nearest_dist_sq) {
            nearest_dist_sq = dist_sq;
            nearest_idx = i32(i);
        }
    }
    return nearest_idx;
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    if (global_id.x != 0u) {
        return;
    }

    // キャシャーンは生成順で最後のユニット
    let index = globals.num_units - 1u;
    var unit = units[index];
    if (unit.faction != 2u || unit.state == 0u) {
        return;
    }

    let base_speed: f32 = 50.0;

    // AI更新（大衆と同じ間隔制御）
    let initial_delay = 60u;
    let should_update_ai = (globals.tick > initial_delay) && ((globals.tick + index) % globals.ai_interval == 0u);

    if (should_update_ai) {
        // 自律的装備変更（大衆と同じルール）
        let rnd = rand(vec2<f32>(f32(index), f32(globals.tick)));
        if (rnd < 0.01) {
            var max_weapon = 0u;
            if (globals.tick > globals.weapon_interval * 3u) { max_weapon = 3u; }
            else if (globals.tick > globals.weapon_interval * 2u) { max_weapon = 2u; }
            else if (globals.tick > globals.weapon_interval) { max_weapon = 1u; }
            let weapon_choice = u32(rand(vec2<f32>(f32(index), f32(globals.tick) + 1.0)) * f32(max_weapon + 1u));
            unit.weapon_id = weapon_choice;
        }

        // 武器パラメータ（従来どおり: 基礎ダメージ10、キャシャーン補正 ×10 / 射程×2）
        var range = 20.0;
        var damage = 10;
        if (unit.weapon_id == 1u) {      // Spread
            range = 15.0;
            damage = damage * 2 / 3;
        } else if (unit.weapon_id == 2u) { // Sniper
            range = 60.0;
        } else if (unit.weapon_id == 3u) { // Melee
            range = 5.0;
            damage = damage * 5;
        }
        damage *= 10;
        range *= 2.0;

        var mode = globals.casshern_mode;
        var new_vel = unit.vel;
        var attack_idx: i32 = -1;

        // ---- モードごとの前提確定（ロックの検証とフォールバック） ----
        var andro_centroid = vec2<f32>(-1.0, -1.0);
        if (mode == 1u) {
            // 突撃: ボス（rank>=2）のロックを検証。無効なら最寄りのボスをロックし直す
            var boss_ok = false;
            if (cstate.lock_boss >= 0) {
                let b = units[u32(cstate.lock_boss)];
                boss_ok = (b.state != 0u && b.faction == 0u && b.rank >= 2u);
            }
            if (!boss_ok) {
                cstate.lock_boss = scan_nearest_boss(unit.pos);
                cstate.assault_contact = 0u;
            }
            if (cstate.lock_boss == -1) {
                mode = 0u; // ボス全滅 → 殲滅にフォールバック
            }
        } else if (mode == 2u) {
            // 援護: 護衛対象（前線の人類）のロックを検証
            andro_centroid = scan_andro_centroid();
            if (andro_centroid.x < 0.0) {
                mode = 0u; // 敵が居ない → 殲滅（敵なしなら停止する）
            } else {
                let candidate = scan_frontline_human(andro_centroid);
                if (candidate == -1) {
                    mode = 0u; // 人類全滅 → 殲滅にフォールバック
                } else if (!is_valid_target(cstate.guard_human, 1u)) {
                    cstate.guard_human = candidate;
                    cstate.engaging = 0u;
                } else if (candidate != cstate.guard_human) {
                    // 乗り換えマージン: 候補が現対象より重心に3割以上近い場合のみ
                    let d_cand = distance_sq(units[u32(candidate)].pos, andro_centroid);
                    let d_cur = distance_sq(units[u32(cstate.guard_human)].pos, andro_centroid);
                    if (d_cand < d_cur * 0.49) {
                        cstate.guard_human = candidate;
                        cstate.engaging = 0u;
                    }
                }
            }
        }

        // ---- モード別挙動 ----
        if (mode == 1u) {
            // ===== 突撃: ロックしたボスを狩る =====
            let boss = units[u32(cstate.lock_boss)];
            let dist_boss = length(boss.pos - unit.pos);

            // 接触状態のヒステリシス: 射程内で接触、射程×1.5を超えたら離脱
            if (cstate.assault_contact == 0u) {
                if (dist_boss <= range) { cstate.assault_contact = 1u; }
            } else {
                if (dist_boss > range * 1.5) { cstate.assault_contact = 0u; }
            }

            if (cstate.assault_contact == 1u) {
                // 接触中: その場でボスを殴り続ける（雑兵に流れない）
                new_vel = vec2<f32>(0.0, 0.0);
                attack_idx = cstate.lock_boss;
            } else {
                // 接近中: 速度100でボスへ。進路の最寄りの敵が射程内なら殴る
                new_vel = normalize_vec(boss.pos - unit.pos) * base_speed * 2.0;
                let n = scan_nearest_andro(index, unit.pos);
                if (n != -1 && sqrt(distance_sq(units[u32(n)].pos, unit.pos)) < range) {
                    attack_idx = n;
                }
            }
        } else if (mode == 2u) {
            // ===== 援護: 前線の人類の盾になる =====
            let human = units[u32(cstate.guard_human)];
            // 持ち場: 護衛対象から敵重心の方向へ 35px
            let post = human.pos + normalize_vec(andro_centroid - human.pos) * 35.0;

            // 迎撃状態のヒステリシス: 持ち場の80px以内で迎撃開始、120px外で離脱
            if (cstate.engaging == 0u) {
                let n = scan_nearest_andro(index, post);
                if (n != -1 && sqrt(distance_sq(units[u32(n)].pos, post)) < 80.0) {
                    cstate.engaging = 1u;
                    cstate.engage_enemy = n;
                }
            }
            if (cstate.engaging == 1u) {
                if (!is_valid_target(cstate.engage_enemy, 0u)) {
                    cstate.engaging = 0u;
                } else if (sqrt(distance_sq(units[u32(cstate.engage_enemy)].pos, post)) > 120.0) {
                    cstate.engaging = 0u;
                }
            }

            if (cstate.engaging == 1u) {
                // 迎撃中: その敵を追って殴る
                let e = units[u32(cstate.engage_enemy)];
                new_vel = normalize_vec(e.pos - unit.pos) * base_speed;
                if (sqrt(distance_sq(e.pos, unit.pos)) < range) {
                    attack_idx = cstate.engage_enemy;
                }
            } else {
                // 持ち場へ帰還（速度125）。到着したら止まり、射程内の敵は殴る
                let to_post = post - unit.pos;
                if (length(to_post) > 10.0) {
                    new_vel = normalize_vec(to_post) * base_speed * 2.5;
                } else {
                    new_vel = vec2<f32>(0.0, 0.0);
                }
                let n = scan_nearest_andro(index, unit.pos);
                if (n != -1 && sqrt(distance_sq(units[u32(n)].pos, unit.pos)) < range) {
                    attack_idx = n;
                }
            }
        } else {
            // ===== 殲滅: 最寄りの敵をロックして追う =====
            let nearest = scan_nearest_andro(index, unit.pos);
            if (nearest == -1) {
                new_vel = vec2<f32>(0.0, 0.0);
            } else {
                if (!is_valid_target(cstate.lock_enemy, 0u)) {
                    cstate.lock_enemy = nearest;
                } else if (nearest != cstate.lock_enemy) {
                    // 乗り換えマージン: 別の敵がロック対象の半分以下の距離に来た場合のみ
                    let d_near = distance_sq(units[u32(nearest)].pos, unit.pos);
                    let d_lock = distance_sq(units[u32(cstate.lock_enemy)].pos, unit.pos);
                    if (d_near < d_lock * 0.25) {
                        cstate.lock_enemy = nearest;
                    }
                }
                let t = units[u32(cstate.lock_enemy)];
                new_vel = normalize_vec(t.pos - unit.pos) * base_speed;
                if (sqrt(distance_sq(t.pos, unit.pos)) < range) {
                    attack_idx = cstate.lock_enemy;
                }
            }
        }

        // 攻撃適用
        if (attack_idx != -1) {
            atomicAdd(&damage_buffer[u32(attack_idx)], damage);
        }
        unit.vel = new_vel;
    }

    // 壁際での跳ね返りを優先（大衆と同じ）
    let margin = 20.0;
    if (unit.pos.x < margin && unit.vel.x > 0.0) { unit.vel.x = abs(unit.vel.x); }
    if (unit.pos.x > globals.map_width - margin && unit.vel.x < 0.0) { unit.vel.x = -abs(unit.vel.x); }
    if (unit.pos.y < margin && unit.vel.y > 0.0) { unit.vel.y = abs(unit.vel.y); }
    if (unit.pos.y > globals.map_height - margin && unit.vel.y < 0.0) { unit.vel.y = -abs(unit.vel.y); }

    // 位置更新
    unit.pos += unit.vel * globals.delta_time;

    // 境界チェック
    if (unit.pos.x < 0.0) { unit.pos.x = 0.0; unit.vel.x *= -1.0; }
    if (unit.pos.x > globals.map_width) { unit.pos.x = globals.map_width; unit.vel.x *= -1.0; }
    if (unit.pos.y < 0.0) { unit.pos.y = 0.0; unit.vel.y *= -1.0; }
    if (unit.pos.y > globals.map_height) { unit.pos.y = globals.map_height; unit.vel.y *= -1.0; }

    units[index] = unit;
}
`;

// ============================
// レンダーシェーダー
// ============================
const RENDER_SHADER = `
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec3<f32>,
}

struct UnitData {
    pos: vec2<f32>,
    vel: vec2<f32>,
    hp: i32,
    state: u32,
    faction: u32,
    rank: u32,
    squad_id: u32,
    morale: f32,
    weapon_id: u32,
    _pad1: u32,
    _pad2: vec4<u32>,
}

struct GlobalUniforms {
    delta_time: f32,
    tick: u32,
    ai_interval: u32,
    human_phase: u32,
    casshern_mode: u32,
    player_input: u32,
    player_target_x: f32,
    player_target_y: f32,
    map_width: f32,
    map_height: f32,
    num_units: u32,
    vision_range: f32,
    andro_dmg: i32,
    human_dmg: i32,
    human_speed_ratio: f32,
    weapon_interval: u32,
}

@group(0) @binding(0) var<storage, read> units: array<UnitData>;
@group(0) @binding(1) var<uniform> globals: GlobalUniforms;

@vertex
fn vs_main(
    @builtin(vertex_index) in_vertex_index: u32,
    @builtin(instance_index) in_instance_index: u32,
) -> VertexOutput {
    let unit = units[in_instance_index];
    
    if (unit.state == 0u) {
        var out: VertexOutput;
        out.clip_position = vec4<f32>(-999.0, -999.0, 0.0, 1.0);
        out.color = vec3<f32>(0.0, 0.0, 0.0);
        return out;
    }
    
    var pos = vec2<f32>(0.0, 0.0);
    if (in_vertex_index == 0u) { pos = vec2<f32>(-0.5, -0.5); }
    else if (in_vertex_index == 1u) { pos = vec2<f32>(0.5, -0.5); }
    else if (in_vertex_index == 2u) { pos = vec2<f32>(-0.5, 0.5); }
    else { pos = vec2<f32>(0.5, 0.5); }

    var size = 4.0;
    
    // サイズ決定
    if (unit.faction == 2u) { size = 12.0; } // キャシャーン
    else if (unit.faction == 0u) {
        if (unit.rank == 3u) { size = 16.0; }      // ブロッケンJr
        else if (unit.rank == 2u) { size = 10.0; } // 四天王
        else if (unit.rank == 1u) { size = 6.0; }  // 小隊長
    } else if (unit.faction == 1u) {
        if (unit.rank == 1u) { size = 6.0; }
    }

    let world_pos = unit.pos + pos * size;
    let screen_size = vec2<f32>(globals.map_width, globals.map_height);
    let clip_pos = (world_pos / screen_size) * 2.0 - 1.0;

    var out: VertexOutput;
    
    // 死亡ユニットは描画しない（画面外へ）
    if (unit.state == 0u) {
        out.clip_position = vec4<f32>(-2.0, -2.0, 0.0, 1.0);
        return out;
    }

    out.clip_position = vec4<f32>(clip_pos.x, -clip_pos.y, 0.0, 1.0);
    
    // 色決定
    if (unit.faction == 0u) { 
        if (unit.rank == 3u) { out.color = vec3<f32>(0.6, 0.0, 0.8); }      // ブロッケンJr: 紫
        else if (unit.rank == 2u) { out.color = vec3<f32>(0.8, 0.0, 0.0); } // 四天王: 濃赤
        else if (unit.rank == 1u) { out.color = vec3<f32>(1.0, 0.4, 0.4); } // 小隊長: 明るい赤
        else { out.color = vec3<f32>(1.0, 0.2, 0.2); }                      // 兵士: 赤
    }
    else if (unit.faction == 1u) { 
        if (unit.rank == 1u) { out.color = vec3<f32>(0.4, 0.4, 1.0); }      // 小隊長: 水色
        else { out.color = vec3<f32>(0.2, 0.2, 1.0); }                      // 兵士: 青
    } 
    else { out.color = vec3<f32>(1.0, 1.0, 1.0); }                          // キャシャーン: 白

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}
`;

// ============================
// 集計シェーダー
// ============================
const REDUCE_SHADER = `
struct UnitData {
    pos: vec2<f32>,
    vel: vec2<f32>,
    hp: i32,
    state: u32,
    faction: u32,
    rank: u32,
    squad_id: u32,
    morale: f32,
    weapon_id: u32,
    _pad1: u32,
    _pad2: vec4<u32>,
}

struct GlobalUniforms {
    delta_time: f32,
    tick: u32,
    ai_interval: u32,
    human_phase: u32,
    casshern_mode: u32,
    player_input: u32,
    player_target_x: f32,
    player_target_y: f32,
    map_width: f32,
    map_height: f32,
    num_units: u32,
    vision_range: f32,
    andro_dmg: i32,
    human_dmg: i32,
    human_speed_ratio: f32,
    weapon_interval: u32,
}

struct FactionStats {
    count: atomic<u32>,
    hp: atomic<i32>,
    _pad1: u32,
    _pad2: u32,
}

@group(0) @binding(0) var<storage, read> units: array<UnitData>;
@group(0) @binding(1) var<storage, read_write> stats: array<FactionStats>;
@group(0) @binding(2) var<uniform> globals: GlobalUniforms;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= globals.num_units) { return; }

    let unit = units[index];
    if (unit.state == 0u) { return; }

    let f = unit.faction;
    if (f > 2u) { return; }

    atomicAdd(&stats[f].count, 1u);
    atomicAdd(&stats[f].hp, unit.hp);
}
`;

// ============================
// メイン
// ============================
async function main() {
  console.log("Initializing Casshern Sim (Grid-Based AI)...");

  await init();
  console.log("WASM initialized.");

  // URLパラメータから設定を読み込む
  const urlParams = new URLSearchParams(window.location.search);
  const mapWidth = parseFloat(urlParams.get('mapW') || '800');
  const mapHeight = parseFloat(urlParams.get('mapH') || '600');
  const weaponInterval = parseInt(urlParams.get('weaponInterval') || '600');

  const androUnits = parseInt(urlParams.get('andro') || '100');
  const humanUnits = parseInt(urlParams.get('human') || '100');
  let configAiInterval = parseInt(urlParams.get('interval') || '3');
  let configVision = parseFloat(urlParams.get('vision') || '30.0');
  const androHp = parseInt(urlParams.get('androHp') || '100');
  const humanHp = parseInt(urlParams.get('humanHp') || '50');
  let androDmg = parseInt(urlParams.get('androDmg') || '10');
  let humanDmg = parseInt(urlParams.get('humanDmg') || '10');
  let phaseInterval = parseInt(urlParams.get('phaseInterval') || '20') * 1000;
  let humanSpeedRatio = parseFloat(urlParams.get('humanSpeed') || '1.0');
  const eliteMult = parseFloat(urlParams.get('eliteMult') || '25.0');
  const brockenMult = parseFloat(urlParams.get('brockenMult') || '100.0');
  const casshernMult = parseFloat(urlParams.get('casshernMult') || '200.0');
  const isTestMode = urlParams.get('test') === 'true';

  if (!navigator.gpu) {
    console.error("WebGPU not supported!");
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { console.error("No adapter!"); return; }

  const device = await adapter.requestDevice();
  console.log("Device acquired.");

  const canvas = document.getElementById('sim-canvas') as HTMLCanvasElement;
  canvas.width = mapWidth;
  canvas.height = mapHeight;

  const context = canvas.getContext('webgpu');
  if (!context) { console.error("No webgpu context!"); return; }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });


  // グリッド定数計算
  const GRID_CELL_SIZE = 100;
  const GRID_COLS = Math.ceil(mapWidth / GRID_CELL_SIZE);
  const GRID_ROWS = Math.ceil(mapHeight / GRID_CELL_SIZE);
  const GRID_TOTAL_CELLS = GRID_COLS * GRID_ROWS;
  const MAX_UNITS_PER_CELL = 64;

  let numUnits = androUnits + humanUnits + 1; // +1 for Casshern
  let unitData: Uint8Array;

  if (isTestMode) {
    console.log("!!! TEST MODE ACTIVATED !!!");
    numUnits = 64; // Small buffer for testing
    unitData = new Uint8Array(numUnits * 64); // Empty buffer
  } else {
    // ユニットデータ生成 (Rust/WASM)
    console.log(`[DEBUG] Calling generate_units_v2(..., mapW=${mapWidth}, mapH=${mapHeight})`);
    unitData = generate_units_v2(androUnits, humanUnits, androHp, humanHp, eliteMult, brockenMult, casshernMult, mapWidth, mapHeight);

    // Rust側でボス（ブロッケンJr+四天王=5体）などが追加されているため、実際のサイズからユニット数を再計算
    numUnits = unitData.length / 64;

    console.log(`[DEBUG] Generated ${numUnits} units (Andro: ${androUnits}, Human: ${humanUnits}, Bosses included). Data size: ${unitData.length} bytes.`);
    console.log(`[DEBUG] AI interval: ${configAiInterval}, Vision: ${configVision}px`);
  }

  // デバッグ: 最初の数ユニットの速度を表示
  const unitSize = 64; // UnitData size in bytes
  const view = new DataView(unitData.buffer);
  for (let i = 0; i < 5; i++) {
    const offset = i * unitSize;
    const px = view.getFloat32(offset + 0, true);
    const py = view.getFloat32(offset + 4, true);
    const vx = view.getFloat32(offset + 8, true);
    const vy = view.getFloat32(offset + 12, true);
    const faction = view.getUint32(offset + 24, true);
    console.log(`Unit ${i}: pos=(${px.toFixed(1)}, ${py.toFixed(1)}), vel=(${vx.toFixed(1)}, ${vy.toFixed(1)}), faction=${faction}`);
  }

  // バッファ作成
  const unitBuffer = device.createBuffer({
    size: unitData.length,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(unitBuffer, 0, unitData as any);

  const uniformBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // グリッド用Uniform (48 bytes - must match shader struct with padding)
  const gridUniformBuffer = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // GridUniforms: grid_cols(u32), grid_rows(u32), cell_size(f32), num_units(u32), max_per_cell(u32), _pad(vec3<u32>)
  const gridUniformData = new ArrayBuffer(48);
  const gridView = new DataView(gridUniformData);
  gridView.setUint32(0, GRID_COLS, true);
  gridView.setUint32(4, GRID_ROWS, true);
  gridView.setFloat32(8, GRID_CELL_SIZE, true);
  gridView.setUint32(12, numUnits, true);
  gridView.setUint32(16, MAX_UNITS_PER_CELL, true);
  // padding: bytes 20-47 are already 0
  device.queue.writeBuffer(gridUniformBuffer, 0, gridUniformData as any);

  // グリッドカウント (各セルのユニット数)
  const gridCountBuffer = device.createBuffer({
    size: GRID_TOTAL_CELLS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // グリッドクリア用ゼロバッファ (GPU側)
  const zeroGridBuffer = device.createBuffer({
    size: GRID_TOTAL_CELLS * 4,
    usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(zeroGridBuffer, 0, new Uint32Array(GRID_TOTAL_CELLS).fill(0) as any);

  // グリッドセル (各セルに格納されたユニットインデックス)
  const gridCellsBuffer = device.createBuffer({
    size: GRID_TOTAL_CELLS * MAX_UNITS_PER_CELL * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // ダメージバッファ (Atomic操作用)
  const damageBuffer = device.createBuffer({
    size: numUnits * 4, // i32
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // 初期化（0埋め）
  device.queue.writeBuffer(damageBuffer, 0, new Int32Array(numUnits).fill(0) as any);

  // キャシャーン専用AIの状態バッファ (CasshernState: 8 * 4 bytes = 32 bytes)
  // lock_enemy, lock_boss, guard_human, engage_enemy (i32, -1 = なし),
  // engaging, assault_contact (u32), pad x2
  const casshernStateInit = new Int32Array([-1, -1, -1, -1, 0, 0, 0, 0]);
  const casshernStateBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(casshernStateBuffer, 0, casshernStateInit);

  // 集計用バッファ (3 factions * 16 bytes = 48 bytes)
  // FactionStats: count(u32), hp(i32), pad(u32), pad(u32)
  const STATS_BUFFER_SIZE = 48;
  const statsBuffer = device.createBuffer({
    size: STATS_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });

  // クリア用ゼロバッファ
  const zeroStatsBuffer = device.createBuffer({
    size: STATS_BUFFER_SIZE,
    usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(zeroStatsBuffer, 0, new Int32Array(STATS_BUFFER_SIZE / 4).fill(0) as any);

  // リードバック用バッファ (ダブルバッファリング)
  const readbackBuffers = [
    device.createBuffer({
      size: STATS_BUFFER_SIZE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    }),
    device.createBuffer({
      size: STATS_BUFFER_SIZE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
  ];

  console.log(`Grid: ${GRID_COLS}x${GRID_ROWS} = ${GRID_TOTAL_CELLS} cells`);

  // シェーダーモジュール
  const gridBuildModule = device.createShaderModule({ code: GRID_BUILD_SHADER });
  const computeModule = device.createShaderModule({ code: COMPUTE_SHADER });
  const renderModule = device.createShaderModule({ code: RENDER_SHADER });
  const reduceModule = device.createShaderModule({ code: REDUCE_SHADER });

  // グリッド構築パイプライン
  const gridBuildLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ]
  });

  const gridBuildBindGroup = device.createBindGroup({
    layout: gridBuildLayout,
    entries: [
      { binding: 0, resource: { buffer: unitBuffer } },
      { binding: 1, resource: { buffer: gridUniformBuffer } },
      { binding: 2, resource: { buffer: gridCountBuffer } },
      { binding: 3, resource: { buffer: gridCellsBuffer } },
    ]
  });

  const gridBuildPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [gridBuildLayout] }),
    compute: { module: gridBuildModule, entryPoint: 'main' }
  });

  // AI計算パイプライン
  const computeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // damage_buffer
    ]
  });

  const computeBindGroup = device.createBindGroup({
    layout: computeLayout,
    entries: [
      { binding: 0, resource: { buffer: unitBuffer } },
      { binding: 1, resource: { buffer: uniformBuffer } },
      { binding: 2, resource: { buffer: gridUniformBuffer } },
      { binding: 3, resource: { buffer: gridCountBuffer } },
      { binding: 4, resource: { buffer: gridCellsBuffer } },
      { binding: 5, resource: { buffer: damageBuffer } },
    ]
  });

  const computePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
    compute: { module: computeModule, entryPoint: 'main' }
  });

  // キャシャーン専用AIパイプライン（単体dispatch）
  const casshernModule = device.createShaderModule({ code: CASSHERN_SHADER });
  const casshernLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // casshern state
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // damage_buffer
    ]
  });

  const casshernBindGroup = device.createBindGroup({
    layout: casshernLayout,
    entries: [
      { binding: 0, resource: { buffer: unitBuffer } },
      { binding: 1, resource: { buffer: uniformBuffer } },
      { binding: 2, resource: { buffer: casshernStateBuffer } },
      { binding: 3, resource: { buffer: damageBuffer } },
    ]
  });

  const casshernPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [casshernLayout] }),
    compute: { module: casshernModule, entryPoint: 'main' }
  });

  // レンダーパイプライン
  const renderLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ]
  });

  const renderBindGroup = device.createBindGroup({
    layout: renderLayout,
    entries: [
      { binding: 0, resource: { buffer: unitBuffer } },
      { binding: 1, resource: { buffer: uniformBuffer } },
    ]
  });

  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [renderLayout] }),
    vertex: { module: renderModule, entryPoint: 'vs_main' },
    fragment: { module: renderModule, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-strip' }
  });

  // 集計パイプライン
  const reduceLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]
  });

  const reduceBindGroup = device.createBindGroup({
    layout: reduceLayout,
    entries: [
      { binding: 0, resource: { buffer: unitBuffer } },
      { binding: 1, resource: { buffer: statsBuffer } },
      { binding: 2, resource: { buffer: uniformBuffer } },
    ]
  });

  const reducePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [reduceLayout] }),
    compute: { module: reduceModule, entryPoint: 'main' }
  });

  console.log("Pipelines created.");

  if (isTestMode) {
    await runTests(
      device, unitBuffer, statsBuffer, uniformBuffer,
      reducePipeline, reduceBindGroup,
      computePipeline, computeBindGroup,
      gridBuildPipeline, gridBuildBindGroup,
      gridCountBuffer,
      numUnits
    );
    return; // Stop here
  }

  // シミュレーション状態
  let tick = 0;
  let humanPhase = 0;
  let lastTime = performance.now();

  // setInterval削除

  // キャシャーンAIモード: 0=殲滅(デフォルト), 1=突撃, 2=援護
  let casshernMode = 0;

  // グリッドクリア用ゼロバッファ

  function render() {
    const now = performance.now();
    const deltaTime = (now - lastTime) / 1000;
    lastTime = now;
    tick++;

    // Uniform更新
    // Uniform buffer: 正しい型でパッキング
    // GlobalUniforms: delta_time(f32), tick(u32), ai_interval(u32), human_phase(u32),
    //                 casshern_mode(u32), player_input(u32), player_target_x(f32), player_target_y(f32),
    //                 map_width(f32), map_height(f32), num_units(u32), _pad(u32)
    //                 map_width(f32), map_height(f32), num_units(u32), vision_range(f32),
    //                 andro_dmg(i32), human_dmg(i32), _pad1(u32), _pad2(u32)
    const uniformData = new ArrayBuffer(64);
    const uniformView = new DataView(uniformData);
    uniformView.setFloat32(0, deltaTime, true);   // delta_time
    uniformView.setUint32(4, tick, true);         // tick
    uniformView.setUint32(8, configAiInterval, true); // ai_interval
    uniformView.setUint32(12, humanPhase, true);  // human_phase
    uniformView.setUint32(16, casshernMode, true); // casshern_mode: 0=殲滅, 1=突撃, 2=援護
    uniformView.setUint32(20, 0, true);           // player_input
    uniformView.setFloat32(24, 0, true);          // player_target_x (unused)
    uniformView.setFloat32(28, 0, true);          // player_target_y (unused)
    uniformView.setFloat32(32, mapWidth, true);  // map_width
    uniformView.setFloat32(36, mapHeight, true); // map_height
    uniformView.setUint32(40, numUnits, true);    // num_units
    uniformView.setFloat32(44, configVision, true); // vision_range
    uniformView.setInt32(48, androDmg, true);     // andro_dmg
    uniformView.setInt32(52, humanDmg, true);     // human_dmg
    uniformView.setFloat32(56, humanSpeedRatio, true); // human_speed_ratio
    uniformView.setUint32(60, weaponInterval, true);   // weapon_interval

    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // グリッドカウントをクリア
    // グリッドカウントをクリア (CopyBufferToBufferで同期を保証)
    // device.queue.writeBuffer(gridCountBuffer, 0, zeroBuffer); // 廃止

    const encoder = device.createCommandEncoder();

    // 明示的にグリッドカウンタをクリア
    encoder.copyBufferToBuffer(zeroGridBuffer, 0, gridCountBuffer, 0, GRID_TOTAL_CELLS * 4);

    // Pass 1: グリッド構築
    const gridPass = encoder.beginComputePass();
    gridPass.setPipeline(gridBuildPipeline);
    gridPass.setBindGroup(0, gridBuildBindGroup);
    gridPass.dispatchWorkgroups(Math.ceil(numUnits / 64));
    gridPass.end();

    // Pass 2: AI計算
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, computeBindGroup);
    computePass.dispatchWorkgroups(Math.ceil(numUnits / 64));
    computePass.end();

    // Pass 2.5: キャシャーン専用AI（1体だけを別dispatchで処理）
    const casshernPass = encoder.beginComputePass();
    casshernPass.setPipeline(casshernPipeline);
    casshernPass.setBindGroup(0, casshernBindGroup);
    casshernPass.dispatchWorkgroups(1);
    casshernPass.end();

    // Render Pass
    const textureView = context!.getCurrentTexture().createView();
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.05, g: 0.05, b: 0.1, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, renderBindGroup);
    renderPass.draw(4, numUnits);
    renderPass.end();

    // 4. 集計パス & リードバック (ダブルバッファリング)
    const writeIndex = tick % 2;
    const readIndex = (tick + 1) % 2;
    const writeBuffer = readbackBuffers[writeIndex];
    const readBuffer = readbackBuffers[readIndex];

    // 書き込み先がマップ中でない場合のみ実行
    if (writeBuffer.mapState === 'unmapped') {
      // statsBufferをクリア (コマンドエンコーダ内で実行して同期を保証)
      encoder.copyBufferToBuffer(zeroStatsBuffer, 0, statsBuffer, 0, STATS_BUFFER_SIZE);

      const reducePass = encoder.beginComputePass();
      reducePass.setPipeline(reducePipeline);
      reducePass.setBindGroup(0, reduceBindGroup);
      reducePass.dispatchWorkgroups(Math.ceil(numUnits / 64));
      reducePass.end();

      // リードバック用コピー (今のフレーム用バッファへ)
      encoder.copyBufferToBuffer(statsBuffer, 0, writeBuffer, 0, STATS_BUFFER_SIZE);
    }

    device.queue.submit([encoder.finish()]);

    // 6. データ読み取りとHUD更新 (前のフレーム用バッファから)
    if (readBuffer.mapState === 'unmapped') {
      readBuffer.mapAsync(GPUMapMode.READ).then(() => {
        const arrayBuffer = readBuffer.getMappedRange();
        const data = new Int32Array(arrayBuffer.slice(0));
        readBuffer.unmap();

        // Andro (idx 0-3)
        const androCount = data[0];
        const androHpSum = data[1]; // Renamed to avoid conflict with initial androHp
        // Human (idx 4-7)
        const humanCount = data[4];
        const humanHpSum = data[5]; // Renamed to avoid conflict with initial humanHp
        // Casshern (idx 8-11)

        // console.log(`HUD Update: Andro=${androCount}, Human=${humanCount}, Casshern=${casshernHp}`);

        // DOM更新
        const androCountEl = document.getElementById('andro-count');
        if (androCountEl) androCountEl.textContent = androCount.toLocaleString();

        const humanCountEl = document.getElementById('human-count');
        if (humanCountEl) humanCountEl.textContent = humanCount.toLocaleString();

        // HPバー更新
        // 初期HPは概算: Andro=100, Human=50, Casshern=50,000,000
        const maxAndroHp = androUnits * androHp;
        const maxHumanHp = humanUnits * humanHp;

        const androHpPct = Math.max(0, Math.min(100, (androHpSum / maxAndroHp) * 100));
        const humanHpPct = Math.max(0, Math.min(100, (humanHpSum / maxHumanHp) * 100));

        const androHpBar = document.getElementById('andro-hp');
        if (androHpBar) androHpBar.style.width = `${androHpPct}%`;

        const humanHpBar = document.getElementById('human-hp');
        if (humanHpBar) humanHpBar.style.width = `${humanHpPct}%`;

        // フェーズをHP比率で決定
        // EARLY: HP > 70%, MID: 30-70%, LATE: < 30%
        let newPhase = 0;
        if (humanHpPct < 30) {
          newPhase = 2; // LATE
        } else if (humanHpPct < 70) {
          newPhase = 1; // MID
        } else {
          newPhase = 0; // EARLY
        }
        if (newPhase !== humanPhase) {
          humanPhase = newPhase;
          console.log(`Phase changed to: ${['Early', 'Mid', 'Late'][humanPhase]} (Human HP: ${humanHpPct.toFixed(1)}%)`);
        }

      }).catch(err => {
        console.error("MapAsync error:", err);
      });
    }

    // (時間ベースのフェーズ更新は削除し、HP比率ベースに変更済み)

    // フェーズ表示のみ更新 (他は毎フレーム更新される)
    const phaseDisplay = document.getElementById('phase-display');
    if (phaseDisplay) {
      const phases = ['EARLY', 'MID', 'LATE'];
      phaseDisplay.textContent = phases[humanPhase];
      phaseDisplay.className = `phase-value ${phases[humanPhase].toLowerCase()}`;
    }

    // 進化ゲージ更新 (武器アンロック状況)
    const weapon1 = document.getElementById('weapon-1');
    const weapon2 = document.getElementById('weapon-2');
    const weapon3 = document.getElementById('weapon-3');

    // シェーダー内のロジックに合わせてUI更新
    if (tick > weaponInterval && weapon1) { weapon1.classList.remove('locked'); weapon1.classList.add('unlocked'); }
    if (tick > weaponInterval * 2 && weapon2) { weapon2.classList.remove('locked'); weapon2.classList.add('unlocked'); }
    if (tick > weaponInterval * 3 && weapon3) { weapon3.classList.remove('locked'); weapon3.classList.add('unlocked'); }
    if (weapon1) {
      if (tick > 600) {
        weapon1.classList.remove('locked');
        weapon1.classList.add('unlocked');
      } else {
        weapon1.classList.add('locked');
        weapon1.classList.remove('unlocked');
      }
    }
    if (weapon2) {
      if (tick > 1200) {
        weapon2.classList.remove('locked');
        weapon2.classList.add('unlocked');
      } else {
        weapon2.classList.add('locked');
        weapon2.classList.remove('unlocked');
      }
    }
    if (weapon3) {
      if (tick > 1800) {
        weapon3.classList.remove('locked');
        weapon3.classList.add('unlocked');
      } else {
        weapon3.classList.add('locked');
        weapon3.classList.remove('unlocked');
      }
    }

    // HUD更新（フェーズ以外は不要だが、念のため既存のupdateHUD呼び出しがあれば削除するか空にする）
    // updateHUD(); // 廃止

    requestAnimationFrame(render);
  }

  // 設定パネル（常時表示）
  const androUnitsSlider = document.getElementById('andro-units-slider') as HTMLInputElement;
  const androUnitsValueEl = document.getElementById('andro-units-value');
  const humanUnitsSlider = document.getElementById('human-units-slider') as HTMLInputElement;
  const humanUnitsValueEl = document.getElementById('human-units-value');
  const aiIntervalSlider = document.getElementById('ai-interval-slider') as HTMLInputElement;
  const aiIntervalValueEl = document.getElementById('ai-interval-value');
  const visionSlider = document.getElementById('vision-slider') as HTMLInputElement;
  const visionValueEl = document.getElementById('vision-value');
  const androDmgSlider = document.getElementById('andro-dmg-slider') as HTMLInputElement;
  const androDmgValueEl = document.getElementById('andro-dmg-value');
  const humanDmgSlider = document.getElementById('human-dmg-slider') as HTMLInputElement;
  const humanDmgValueEl = document.getElementById('human-dmg-value');
  const phaseIntervalSlider = document.getElementById('phase-interval-slider') as HTMLInputElement;
  const phaseIntervalValueEl = document.getElementById('phase-interval-value');
  const humanSpeedSlider = document.getElementById('human-speed-slider') as HTMLInputElement;
  const humanSpeedValueEl = document.getElementById('human-speed-value');
  const eliteMultSlider = document.getElementById('elite-mult-slider') as HTMLInputElement;
  const eliteMultValueEl = document.getElementById('elite-mult-value');
  const brockenMultSlider = document.getElementById('brocken-mult-slider') as HTMLInputElement;
  const brockenMultValueEl = document.getElementById('brocken-mult-value');
  const casshernMultSlider = document.getElementById('casshern-mult-slider') as HTMLInputElement;
  const casshernMultValueEl = document.getElementById('casshern-mult-value');
  const restartBtn = document.getElementById('restart-btn');

  // スライダー初期値をURLパラメータに合わせる
  if (androUnitsSlider) { androUnitsSlider.value = String(androUnits); }
  if (androUnitsValueEl) { androUnitsValueEl.textContent = String(androUnits); }
  if (humanUnitsSlider) { humanUnitsSlider.value = String(humanUnits); }
  if (humanUnitsValueEl) { humanUnitsValueEl.textContent = String(humanUnits); }
  if (aiIntervalSlider) { aiIntervalSlider.value = String(configAiInterval); }
  if (aiIntervalValueEl) { aiIntervalValueEl.textContent = String(configAiInterval); }
  if (visionSlider) { visionSlider.value = String(configVision); }
  if (visionValueEl) { visionValueEl.textContent = String(configVision); }
  if (androDmgSlider) { androDmgSlider.value = String(androDmg); }
  if (androDmgValueEl) { androDmgValueEl.textContent = String(androDmg); }
  if (humanDmgSlider) { humanDmgSlider.value = String(humanDmg); }
  if (humanDmgValueEl) { humanDmgValueEl.textContent = String(humanDmg); }
  if (phaseIntervalSlider) { phaseIntervalSlider.value = String(phaseInterval / 1000); }
  if (phaseIntervalValueEl) { phaseIntervalValueEl.textContent = String(phaseInterval / 1000); }
  if (humanSpeedSlider) { humanSpeedSlider.value = String(humanSpeedRatio); }
  if (humanSpeedValueEl) { humanSpeedValueEl.textContent = String(humanSpeedRatio); }
  if (eliteMultSlider) { eliteMultSlider.value = String(eliteMult); }
  if (eliteMultValueEl) { eliteMultValueEl.textContent = String(eliteMult); }
  if (brockenMultSlider) { brockenMultSlider.value = String(brockenMult); }
  if (brockenMultValueEl) { brockenMultValueEl.textContent = String(brockenMult); }
  if (casshernMultSlider) { casshernMultSlider.value = String(casshernMult); }
  if (casshernMultValueEl) { casshernMultValueEl.textContent = String(casshernMult); }

  // スライダー更新
  androUnitsSlider?.addEventListener('input', () => {
    if (androUnitsValueEl) androUnitsValueEl.textContent = androUnitsSlider.value;
  });
  humanUnitsSlider?.addEventListener('input', () => {
    if (humanUnitsValueEl) humanUnitsValueEl.textContent = humanUnitsSlider.value;
  });
  visionSlider?.addEventListener('input', () => {
    configVision = parseFloat(visionSlider.value); // Real-time update
    if (visionValueEl) visionValueEl.textContent = visionSlider.value;
  });
  aiIntervalSlider?.addEventListener('input', () => {
    configAiInterval = parseInt(aiIntervalSlider.value); // Real-time update
    if (aiIntervalValueEl) aiIntervalValueEl.textContent = aiIntervalSlider.value;
  });
  androDmgSlider?.addEventListener('input', () => {
    androDmg = parseInt(androDmgSlider.value); // Real-time update
    if (androDmgValueEl) androDmgValueEl.textContent = androDmgSlider.value;
  });
  humanDmgSlider?.addEventListener('input', () => {
    humanDmg = parseInt(humanDmgSlider.value); // Real-time update
    if (humanDmgValueEl) humanDmgValueEl.textContent = humanDmgSlider.value;
  });
  phaseIntervalSlider?.addEventListener('input', () => {
    phaseInterval = parseInt(phaseIntervalSlider.value) * 1000;
    if (phaseIntervalValueEl) phaseIntervalValueEl.textContent = phaseIntervalSlider.value;
  });
  humanSpeedSlider?.addEventListener('input', () => {
    humanSpeedRatio = parseFloat(humanSpeedSlider.value);
    if (humanSpeedValueEl) humanSpeedValueEl.textContent = humanSpeedSlider.value;
  });
  eliteMultSlider?.addEventListener('input', () => {
    if (eliteMultValueEl) eliteMultValueEl.textContent = eliteMultSlider.value;
  });
  brockenMultSlider?.addEventListener('input', () => {
    if (brockenMultValueEl) brockenMultValueEl.textContent = brockenMultSlider.value;
  });
  casshernMultSlider?.addEventListener('input', () => {
    if (casshernMultValueEl) casshernMultValueEl.textContent = casshernMultSlider.value;
  });

  // 再起動ボタン（ページリロード + クエリパラメータで設定を渡す）
  restartBtn?.addEventListener('click', () => {
    const andro = androUnitsSlider?.value || '500';
    const human = humanUnitsSlider?.value || '500';
    const interval = aiIntervalSlider?.value || '3';
    const vision = visionSlider?.value || '30.0';
    const aDmg = androDmgSlider?.value || '10';
    const hDmg = humanDmgSlider?.value || '10';
    const pInt = phaseIntervalSlider?.value || '20';
    const hSpd = humanSpeedSlider?.value || '1.0';
    const eMult = eliteMultSlider?.value || '25';
    const bMult = brockenMultSlider?.value || '100';
    const cMult = casshernMultSlider?.value || '200';
    // URLパラメータで設定を保存
    const url = new URL(window.location.href);
    url.searchParams.set('andro', andro);
    url.searchParams.set('human', human);
    url.searchParams.set('interval', interval);
    url.searchParams.set('vision', vision);
    url.searchParams.set('androDmg', aDmg);
    url.searchParams.set('humanDmg', hDmg);
    url.searchParams.set('phaseInterval', pInt);
    url.searchParams.set('humanSpeed', hSpd);
    url.searchParams.set('eliteMult', eMult);
    url.searchParams.set('brockenMult', bMult);
    url.searchParams.set('casshernMult', cMult);
    window.location.href = url.toString();
  });

  // キャシャーンAIモード切り替え
  const casshernModeText = document.getElementById('casshern-mode-text');
  const assaultBtn = document.getElementById('casshern-assault-btn');
  const supportBtn = document.getElementById('casshern-support-btn');
  const annihilateBtn = document.getElementById('casshern-annihilate-btn');

  function updateCasshernModeUI() {
    const modeNames = ['殲滅', '突撃', '援護'];
    if (casshernModeText) casshernModeText.textContent = modeNames[casshernMode];
    assaultBtn?.classList.toggle('active', casshernMode === 1);
    supportBtn?.classList.toggle('active', casshernMode === 2);
    annihilateBtn?.classList.toggle('active', casshernMode === 0);
  }

  // モード切替時はキャシャーンAIの状態（ロック等）をリセットする。
  // リセットは監督（CPU/JS）の仕事：状態バッファを初期値で上書きする。
  function resetCasshernState() {
    device.queue.writeBuffer(casshernStateBuffer, 0, casshernStateInit);
  }

  assaultBtn?.addEventListener('click', () => {
    casshernMode = 1;
    resetCasshernState();
    updateCasshernModeUI();
  });
  supportBtn?.addEventListener('click', () => {
    casshernMode = 2;
    resetCasshernState();
    updateCasshernModeUI();
  });
  annihilateBtn?.addEventListener('click', () => {
    casshernMode = 0;
    resetCasshernState();
    updateCasshernModeUI();
  });

  console.log("Starting simulation with grid-based AI...");
  requestAnimationFrame(render);
}


main().catch(console.error);
