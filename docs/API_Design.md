# 🔌 API設計 & 実装仕様書 (GPU Centric)

## 1. アーキテクチャ変更点
従来の「Rustでロジック、WebGPUで描画」という構成から、**「WebGPU Compute Shaderでロジックと描画の両方を実行」** する構成へ変更します。
Rust (WASM) はコントローラーとしての役割に徹し、重い計算は行いません。

## 2. GPU データ構造 (WGSL)
データの正本は GPU Storage Buffer (SSBO) にあります。

### 2.1 UnitData (SSBO)
```wgsl
struct UnitData {
    pos: vec2<f32>,
    vel: vec2<f32>,
    hp: i32,
    state: u32,       // 0:Dead, 1:Idle, 2:Move, 3:Attack
    faction: u32,     // 0:Andro, 1:Human, 2:Special
    rank: u32,        // 0:Soldier, 1:Lieutenant, 2:Elite/Captain, 3:Boss/General
    squad_id: u32,    // 所属小隊ID
    morale: f32,      // 士気 (0.0 - 1.0)
    weapon_id: u32,   // 装備ID
    _pad1: u32,
    _pad2: vec4<u32>, // 64バイトアライメント用
}

@group(0) @binding(0) var<storage, read_write> units: array<UnitData>;
```

### 2.2 GlobalUniforms (Uniform Buffer)
CPUからGPUへ毎フレーム送信される制御データです。

```wgsl
struct GlobalUniforms {
    delta_time: f32,
    tick: u32,
    ai_interval: u32,
    human_phase: u32, // 0:Early, 1:Mid, 2:Late
    casshern_mode: u32, // 0:Annihilate, 1:Assault, 2:Support
    player_input: u32,  // (未使用)
    player_target_x: f32, // (未使用)
    player_target_y: f32, // (未使用)
    map_width: f32,
    map_height: f32,
    num_units: u32,
    vision_range: f32,
    andro_dmg: i32,
    human_dmg: i32,
    human_speed_ratio: f32,
    _pad2: u32,
}

@group(0) @binding(1) var<uniform> globals: GlobalUniforms;
```

## 3. Compute Shader カーネル
### 3.1 `compute_ai.wgsl`
AI思考ロジックを担当します。`globals.tick % globals.ai_interval == 0` の時のみディスパッチされます。

*   **近接探索**: グリッドインデックスを計算し、近傍セルのユニットIDを参照します。
*   **アンドロAI**: `if faction == 0`。単純な追尾・攻撃ロジック。
*   **人類AI**: `if faction == 1`。`human_phase` と `morale` に基づく状態遷移。
*   **キャシャーンAI**: `if faction == 2`。`player_input_active` なら入力ベクトルを使用、そうでなければ `casshern_mode` に従う。

### 3.2 `compute_physics.wgsl`
物理演算を担当します。毎フレーム実行されます。
*   速度ベクトルによる位置更新。
*   マップ境界での反射/停止。
*   グリッドバッファへの登録更新。

## 4. Rust / WASM インターフェース

**変更点**: 当初の設計ではRust側でメインループとWebGPU制御を行う予定でしたが、実装段階でのWebGPU (wgpu) のWASM環境における不安定さを回避するため、**TypeScript (JS) 側でメインループとWebGPU API制御を行うアーキテクチャに変更**しました。
Rust (WASM) は「高速な初期データ生成」のみを担当します。

### 4.1 Rust Functions (wasm-bindgen)

```rust
#[wasm_bindgen]
pub fn generate_units_v2(
    andro_count: u32, 
    human_count: u32, 
    andro_hp: i32, 
    human_hp: i32,
    elite_mult: f32,    // 四天王HP倍率
    brocken_mult: f32,  // ブロッケンJr HP倍率
    casshern_mult: f32  // キャシャーン HP倍率
) -> Vec<u8> {
    // ユニットデータのバイナリ配列 (Uint8Array) を返す
    // ...
}
```

シミュレーションのステート（UnitData, GlobalUniforms）は **GPU上のバッファ (SSBO/Uniform) が正本** となり、Rust側では状態を保持しません。
JS側で `requestAnimationFrame` ループを回し、毎フレーム `device.queue.writeBuffer` 等を用いてUniformを更新し、Compute Passをエンコードして実行します。

## 5. フロントエンド (TypeScript)
*   **UI**: React/Vanilla JSで実装。
*   **ループ**: `requestAnimationFrame` で `engine.render()` を呼び続ける。
*   **設定**: 初期化時に `SimConfig` (ユニット数等) を渡す。
