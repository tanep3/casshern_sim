# 📝 SA_Draft_complete.md (System Architecture Draft Complete)

## 1. プロジェクト概要
**プロジェクト名**: Casshern Sim (アンドロ軍団 vs 人類 壮絶戦シミュレータ)
**目的**:
1. 「眺めて楽しい・ちょっと遊べる」戦闘シミュレータの構築。
2. 将来的に汎用化可能な「離散データシミュレーション／群衆戦闘エンジン」の基盤作成。
**技術スタック**:
*   **Logic**: Rust + WASM
*   **Rendering/Compute**: WebGPU (大量ユニットの並列処理)
*   **UI/Glue**: JS/TS

---

## 2. スケールと世界観要件
### 2.1 ユニット規模
*   **アンドロ軍団**: 最大 1,000体 (設計目標)
*   **人類軍団**: 最大 100,000体 (設計目標)
*   **設定可能性**: ゲーム開始時に `ANDRO_COUNT`, `HUMAN_COUNT` をパラメータとして設定可能。
    *   v0段階では小規模(例: 100 vs 1000)から開始するが、アーキテクチャは上記最大数を前提とする。

### 2.2 世界構造
*   **フィールド**: 2D俯瞰視点。固定マップ（画面サイズ＝マップ）。
*   **グリッド**: 視界判定や移動コスト計算のためにグリッド分割を用いる。
*   **地形**: v0では「平地」のみだが、データ構造として「地形適性(Terrain Affinity)」を持てる設計とする。

---

## 3. ユニット設計 (Entity / Trait)
全ユニットは共通のベース構造を持ち、Traitによって特性を付与する。

### 3.1 共通データ構造
*   `id`: ユニークID
*   `faction`: 陣営 (ANDRO, HUMAN, SPECIAL)
*   `archetype`: キャラ種別 (BROCKEN, SOLDIER, CASSHERN etc.)
*   `position`: (x, y)
*   `direction`: 向き
*   `hp / max_hp`: 耐久力
*   `alive_flag`: 生存フラグ
*   `control_mode`: AI / PLAYER

### 3.2 陣営と特性
#### 🤖 アンドロ軍団
*   **目的**: 人類の殲滅速度を最大化する。
*   **特性**:
    *   **恐怖なし**: 味方の死や自身の被害を気にしない。
    *   **単純高火力**: 複雑な連携よりも個々の火力と突撃を優先。
*   **構成**:
    *   **ブロッケンJr**: ボス。最強パラメータ。
    *   **四天王**: 中ボス。
    *   **雑魚アンドロイド**: 近距離・中距離・遠距離タイプ。

#### 🧑‍🤝‍🧑 人類軍団
*   **目的**: 生存しつつ、アンドロ軍団を倒す。
*   **特性**:
    *   **群衆戦術**: 個体は弱いが、数と連携で戦う。
    *   **進化**: 時間経過でTechLevelが上がり、新兵器を使用する。
    *   **二層構造**:
        *   **個体**: 1ユニット＝1人。
        *   **小隊**: 30〜500人単位のグループ。将校（将・佐・尉）が指揮。
        *   ※ WebGPU前提で個体描画するが、ロジック上は小隊単位でまとめて計算する最適化を許容。
*   **構成**:
    *   将軍・佐官・尉官・一般兵。

#### 🦾 キャシャーン (Special)
*   **目的**: アンドロ軍団の撃破（戦局への最大インパクト）。
*   **特性**:
    *   **ヒーローAI**: プレイヤーの指示（モード）に従い、自律的に最適行動をとる。
    *   **モード**: 殲滅 / 突撃 / 援護。

---

## 4. システムモジュール構成
### 4.1 Core Simulation Engine (Rust)
1.  **World / State Module**:
    *   ユニット管理、地形、時間(tick)、TechLevel管理。
2.  **Entity / Trait Module**:
    *   ユニットデータ構造、Trait定義 (`Movable`, `Attackable`, `Perceives` 等)。
3.  **AI / Behavior Module**:
    *   思考ロジックの実装 (`SimpleAggressiveAI`, `TacticalHumanAI`, `HeroBehavior`)。
4.  **Combat / Physics Module**:
    *   移動、衝突判定、射程判定、ダメージ計算。WebGPUオフロード候補。
5.  **Evolution / Tech Module**:
    *   人類の技術進化、兵器アンロック管理。
6.  **Victory / Control Module**:
    *   勝敗判定、シミュレーション制御(Pause/Resume)。

### 4.2 Rendering & UI Layer (JS/TS + WebGPU)
*   **Renderer**: ユニットの大量描画（インスタンシング）。
*   **UI**: ステータス表示、コントロールパネル。

### 4.3 Config & Scenario Layer
*   初期パラメータ設定（ユニット数、攻撃倍率、進化速度など）。

---

## 5. パラメータ設計 (Configurable)
以下の項目はハードコードせず、設定可能にする。
*   `ANDRO_UNIT_COUNT`, `HUMAN_UNIT_COUNT`
*   `HUMAN_TECH_SPEED` (進化速度)
*   `ATTACK_POWER_MULTIPLIER` (各陣営)
*   `CASSHERN_STRENGTH`
*   小隊構成人数上限 (将/佐/尉)

---

## 6. 抽象化と汎用性
*   「アンドロ」「人類」という固有名称に依存しすぎない設計。
*   `Faction` IDと `Trait` の組み合わせで表現し、別テーマ（ゾンビ等）への転用を可能にする。
