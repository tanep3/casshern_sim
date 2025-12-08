use wasm_bindgen::prelude::*;
use bytemuck::{Pod, Zeroable};
use rand::Rng;
use rand::SeedableRng;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct UnitData {
    pub pos: [f32; 2],
    pub vel: [f32; 2],
    pub hp: i32,
    pub state: u32,
    pub faction: u32,
    pub rank: u32,
    pub squad_id: u32,
    pub morale: f32,
    pub weapon_id: u32,
    pub _pad1: u32,
    pub _pad2: [u32; 4],
}

/// ユニットデータ生成
/// - アンドロ: 左側に配置、右方向へのランダム初速
/// - 人類: 右側に配置、左方向へのランダム初速
/// - キャシャーン: 中央に1体、ランダム初速
#[wasm_bindgen]
pub fn generate_units_v2(
    andro_count: u32, 
    human_count: u32, 
    andro_hp: i32, 
    human_hp: i32,
    elite_mult: f32,
    brocken_mult: f32,
    casshern_mult: f32,
    map_width: f32,
    map_height: f32
) -> Vec<u8> {
    let mut units = Vec::new();
    let mut rng = rand::rngs::StdRng::seed_from_u64(42);
    
    // マップ設定
    let map_w = map_width;
    let map_h = map_height;
    let margin_y = 50.0;

    // ---------------------------------------------------------
    // 1. アンドロ軍団 (Faction 0) - 左側配置
    // ---------------------------------------------------------

    // 1-a. ブロッケンJr (大ボス) - 左端中央
    units.push(UnitData {
        pos: [30.0, map_h * 0.5],
        vel: [0.0, 0.0],
        hp: (andro_hp as f32 * brocken_mult) as i32, 
        state: 1,
        faction: 0,
        rank: 3, // General
        squad_id: 0,
        morale: 1.0,
        weapon_id: 0,
        _pad1: 0,
        _pad2: [0; 4],
    });

    // 1-b. 四天王 (中ボス) - ブロッケンJrの周囲
    for i in 0..4 {
        let y_offset = (i as f32 - 1.5) * 40.0;
        units.push(UnitData {
            pos: [80.0, map_h * 0.5 + y_offset],
            vel: [0.0, 0.0],
            hp: (andro_hp as f32 * elite_mult) as i32, 
            state: 1,
            faction: 0,
            rank: 2, // Captain
            squad_id: 0,
            morale: 1.0,
            weapon_id: 0,
            _pad1: 0,
            _pad2: [0; 4],
        });
    }

    // 1-c. 一般アンドロ - 左側広範囲に均等散布
    for i in 0..andro_count {
        // X: 100 ~ 350, Y: margin ~ map_h - margin
        let pos_x = rng.gen_range(100.0..350.0);
        let pos_y = rng.gen_range(margin_y..(map_h - margin_y));
        
        // 右方向へのランダム初速
        let angle = rng.gen::<f32>() * std::f32::consts::PI / 2.0 - std::f32::consts::PI / 4.0; // -45 ~ +45 deg
        let speed = 30.0 + rng.gen::<f32>() * 20.0;

        units.push(UnitData {
            pos: [pos_x, pos_y],
            vel: [angle.cos() * speed, angle.sin() * speed],
            hp: andro_hp,
            state: 1,
            faction: 0,
            rank: if i % 100 == 0 { 1 } else { 0 }, // 1/100で小隊長
            squad_id: (i / 50) as u32,
            morale: 1.0,
            weapon_id: 0,
            _pad1: 0,
            _pad2: [0; 4],
        });
    }

    // ---------------------------------------------------------
    // 2. 人類軍団 (Faction 1) - 右側配置
    // ---------------------------------------------------------

    // 2-a. 一般人類 - 右側広範囲に均等散布
    for i in 0..human_count {
        // X: 450 ~ 700, Y: margin ~ map_h - margin
        let pos_x = rng.gen_range(450.0..750.0);
        let pos_y = rng.gen_range(margin_y..(map_h - margin_y));

        // 左方向へのランダム初速
        let angle = std::f32::consts::PI + rng.gen::<f32>() * std::f32::consts::PI / 2.0 - std::f32::consts::PI / 4.0;
        let speed = 30.0 + rng.gen::<f32>() * 20.0;

        units.push(UnitData {
            pos: [pos_x, pos_y],
            vel: [angle.cos() * speed, angle.sin() * speed],
            hp: human_hp,
            state: 1,
            faction: 1,
            rank: if i % 50 == 0 { 1 } else { 0 },
            squad_id: (i / 20) as u32,
            morale: 0.8, // 初期士気
            weapon_id: 0,
            _pad1: 0,
            _pad2: [0; 4],
        });
    }

    // ---------------------------------------------------------
    // 3. キャシャーン (Faction 2) - 人類陣営の右端中央
    // ---------------------------------------------------------
    {
        // ユーザー要望: 画面の一番右
        let start_pos_x = map_w - 20.0;
        let start_pos_y = map_h * 0.5;
        units.push(UnitData {
            pos: [start_pos_x, start_pos_y],
            vel: [-50.0, 0.0], // 左へ突撃
            hp: (andro_hp as f32 * casshern_mult) as i32, 
            state: 1,
            faction: 2, // Special (Casshern)
            rank: 3,    // Boss rank
            squad_id: 9999,
            morale: 1.0,
            weapon_id: 0,
            _pad1: 0,
            _pad2: [0; 4],
        });
    }
    
    // バイト列に変換
    let mut bytes = Vec::with_capacity(units.len() * std::mem::size_of::<UnitData>());
    for unit in units {
        bytes.extend_from_slice(unsafe {
            std::slice::from_raw_parts(
                &unit as *const UnitData as *const u8,
                std::mem::size_of::<UnitData>(),
            )
        });
    }
    bytes
}

#[wasm_bindgen]
pub fn get_unit_size() -> u32 {
    std::mem::size_of::<UnitData>() as u32
}

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
    log("WASM module loaded.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unit_data_size() {
        assert_eq!(std::mem::size_of::<UnitData>(), 64);
    }

    #[test]
    fn test_generate_units_hp() {
        let andro_count = 10;
        let human_count = 10;
        let andro_hp = 200;
        let human_hp = 50;
        
        let bytes = generate_units_v2(andro_count, human_count, andro_hp, human_hp);
        
        // Header check
        let num_units = andro_count + human_count + 1;
        assert_eq!(bytes.len(), num_units * 64);
        
        // Check Casshern (Index 0)
        let casshern_slice = &bytes[0..64];
        let casshern: UnitData = unsafe { std::ptr::read(casshern_slice.as_ptr() as *const _) };
        assert_eq!(casshern.faction, 2);
        assert_eq!(casshern.hp, 50000000);
        
        // Check Andro (Index 1)
        let andro_slice = &bytes[64..128];
        let andro: UnitData = unsafe { std::ptr::read(andro_slice.as_ptr() as *const _) };
        assert_eq!(andro.faction, 0);
        assert_eq!(andro.hp, andro_hp);
        
        // Check Human (Index 11 -> 1 (Casshern) + 10 (Andro) = 11)
        let human_offset = (1 + andro_count) * 64;
        let human_slice = &bytes[human_offset..human_offset+64];
        let human: UnitData = unsafe { std::ptr::read(human_slice.as_ptr() as *const _) };
        assert_eq!(human.faction, 1);
        assert_eq!(human.hp, human_hp);
    }
}
