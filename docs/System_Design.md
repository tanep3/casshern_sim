# 📐 システム設計書 (System Design Document)

## 1. アーキテクチャ概要
本システムは、**AIロジックと描画処理の両方をWebGPU上で完全並列実行する**「GPUセントリック・アーキテクチャ」を採用する。
CPU（Rust/WASM）は、初期化、UIイベントのハンドリング、およびGPUへのディスパッチ指示のみを担当し、シミュレーションのステート（状態）はGPUメモリ（SSBO）上に保持される。

### 1.1 技術スタック構成
*   **Frontend**: TypeScript, Vite
*   **Compute & Rendering**: WebGPU (WGSL)
*   **Controller**: Rust -> WASM (wasm-bindgen)
*   **Data Storage**: GPU Storage Buffers (SSBO)

## 2. UI設計 (User Interface)
### 2.1 画面レイアウト
*   **メインビュー**: 画面全体を占める戦場マップ。
    *   **描画パイプライン**: AI計算とは独立したパイプラインで、SSBOから位置情報を読み取りインスタンシング描画を行う。
*   **HUD (Head-Up Display)**:
    *   **左上**: FPSカウンター、生存ユニット数（Andro / Human）。
    *   **中上**: **戦局フェーズインジケータ**（現在の人類軍の状態：Early/Mid/Late）および**士気バー**。
    *   **右上**: シミュレーション制御（Pause/Resume/Restart）および**AI計算間隔スライダー**（1〜60 tick）。
    *   **左下**: **キャシャーン指令パネル**。3つのモードボタン（殲滅・突撃・援護）。
    *   **右下**: **兵器アンロック & 装備パネル**。アンロック済み兵器アイコン一覧。クリックで全ユニットの装備を変更。
    *   **画面端**: **重要ターゲットHPバー**（キャシャーン、ブロッケンJr、四天王）。

### 2.2 画面遷移
1.  **設定画面**:
    *   **ユニット数スライダー**: アンドロ（1〜100,000）、人類（1〜100,000）。
    *   **詳細設定スライダー**: 視界範囲、AI間隔、攻撃力、人類移動速度。
    *   **ボス戦力倍率**: 四天王、ブロッケンJr、キャシャーンのHP倍率（1〜1,000倍）。
    *   Startボタン: 設定された数だけGPUバッファを確保し、初期化Compute Shaderを実行。
2.  **シミュレーション画面**: メイン実行画面。
3.  **リザルトオーバーレイ**: 決着時に表示。

## 3. GPUデータモデル (SSBO)
ユニットデータの正本はGPU上にあり、CPUは原則としてこれを保持しない（デバッグ時のみリードバック）。

### 3.1 UnitData (Struct in WGSL)
```wgsl
struct UnitData {
    pos: vec2<f32>,
    vel: vec2<f32>,
    hp: i32,
    state: u32,       // 0:Dead, 1:Idle, 2:Move, 3:Attack
    faction: u32,     // 0:Andro, 1:Human, 2:Special
    rank: u32,        // 0:Soldier, 1:Lieutenant, 2:Elite/Captain, 3:Boss/General
    squad_id: u32,    // 所属小隊ID
    morale: f32,      // 士気値 (0.0 - 1.0)
    weapon_id: u32,   // 現在の装備ID
    _pad1: u32,
    _pad2: vec4<u32>, // 64バイトアライメント用
}
```

### 3.2 GlobalUniforms
```wgsl
struct GlobalUniforms {
    delta_time: f32,
    tick: u32,
    ai_interval: u32,
    human_phase: u32, // 0:Early, 1:Mid, 2:Late
    casshern_mode: u32, // 0:Annihilate, 1:Assault, 2:Support
    player_input: u32,  // (未使用: 将来の拡張用)
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
```

## 4. ロジック設計 (Compute Shaders)
AIロジックは以下のCompute Shaderカーネルに分割される。

### 4.1 `compute_ai.wgsl`
*   **実行頻度**: `tick % ai_interval == 0` の時のみ実行。
*   **役割**:
    *   **近接探索**: グリッド（視界の1/2サイズ）を用いて近傍探索。一般ユニット用。
    *   **アンドロAI**: 最寄りの敵へ突撃。
    *   **人類AI**:
        *   フェーズ（**人類生存HP比率ベース**）に基づく行動決定（Early:逃走, Mid:攻勢, Late:決死突撃）。
        *   **人類AI**:
        *   フェーズ（**人類生存HP比率ベース**）に基づく行動決定（Early:逃走, Mid:攻勢, Late:決死突撃）。
        *   Tick経過による武器進化（Spread, Sniper, Melee）。設定された `weapon_interval` に基づく。
    *   **キャシャーンAI**:
        *   **全視野探索**: グリッドを使わず全ユニットを走査し、最適なターゲットを見つける。
        *   **モード別行動**:
            *   **殲滅**: 最も近い敵を追跡・攻撃。
            *   **突撃**: 高ランク敵（ボス）を優先探索。不在なら敵軍の重心（Cluster）へ移動。
            *   **援護**: 最も近い（またはHPの低い）人類ユニットを検索し、その位置へ急行して護衛。

### 4.2 `compute_physics.wgsl`
*   **実行頻度**: 毎フレーム。
*   **役割**: 速度ベクトルに基づく位置更新、壁衝突、グリッド登録更新。

### 4.3 `compute_combat.wgsl`
*   **実行頻度**: 毎フレーム（またはAIと同じ）。
*   **役割**: 攻撃判定、ダメージ計算、HP更新、死亡フラグ処理。

## 5. 実装戦略
1.  **Phase 1: GPU基盤**: RustからWASM経由でWebGPUコンテキストを初期化し、SSBOを確保する。
2.  **Phase 2: 描画**: SSBOの内容をインスタンシング描画するパイプラインを構築。
3.  **Phase 3: 基本AI**: `compute_physics` と単純な `compute_ai` (ランダム移動) を実装。
4.  **Phase 4: 本格AI**: 視界探索グリッド、陣営別ロジック、小隊システムをWGSLで実装。
5.  **Phase 5: UI結合**: 兵器アンロック、設定画面、キャシャーン操作を実装し、Uniformバッファ経由でGPUに反映。
