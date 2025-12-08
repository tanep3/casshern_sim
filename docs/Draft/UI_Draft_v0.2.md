## 2. UI Draft v0.2 の更新（設計側の整理）

### 2-1. 個体レイヤと小隊レイヤ

UI（設計）視点では、こんな2層構造を意識する：

* **Individual Layer（個体レイヤ）**

  * 全ユニットがここに存在（ID, HP, 位置など）
  * 将来、小隊統合しても「構造上は個体の集まり」として維持

* **Group Layer（小隊レイヤ）**

  * 小隊ごとの情報：

    * 小隊ID
    * 隷属する個体IDリスト or 人数カウント
    * 小隊長（将・佐・尉のいずれか）
    * 小隊の代表位置（センター）
    * 行動モード（防衛／前進／退却など・将来拡張）
  * パフォーマンス都合で、
    「小隊単位で移動・行動をまとめて扱う」最適化モードを許可

> SAの「小隊に所属したら小隊として動かしてよい」を
> UIでは **Individual ↔ Group の両方を持てる設計で保証**するイメージ。

---

## 3. パラメータ一覧（SAで「調整可能」としておきたいもの）

「タルモン提案でOK」と言ってくれたやつ＋追加案をカテゴリ別に並べるね。

### 3-1. ユニット数・規模系

* ANDRO_UNIT_COUNT（アンドロ軍団の初期数）
* HUMAN_UNIT_COUNT（人類軍団の初期数）
* INITIAL_GENERAL_COUNT, INITIAL_COLONEL_COUNT, INITIAL_LIEUTENANT_COUNT
  （将・佐・尉の人数）※デフォはさっきの 3 / 3 / 9
* PLATOON_SIZE_MAX_GENERAL（将の小隊最大人数：初期500）
* PLATOON_SIZE_MAX_COLONEL（佐：初期100）
* PLATOON_SIZE_MAX_LIEUTENANT（尉：初期30）

---

### 3-2. 能力・ステータス補正系

* ANDRO_ATTACK_MULTIPLIER
* ANDRO_DEFENSE_MULTIPLIER
* HUMAN_ATTACK_MULTIPLIER
* HUMAN_DEFENSE_MULTIPLIER
* CASSHERN_POWER_MULTIPLIER（キャシャーンの強さ倍率）
* COMMAND_EFFECTIVENESS（指揮バフの効き具合：将来使う）

---

### 3-3. 進化・テック系

* HUMAN_TECH_SPEED（進化速度：時間あたりのTechLevel上昇）
* TECH_UNLOCK_TIMINGS（どの時間で何がアンロックされるかのテーブル）

→ 将来は「倒した敵数で進化速度UP」とかも足せる。

---

### 3-4. AI・行動特性系

* ANDRO_AGGRESSIVENESS（アンドロの突撃性）

  * 高いほど敵を積極的に追う
* HUMAN_COHESION_LEVEL（人類のまとまりやすさ）

  * 陣形崩壊しにくさ
* CASSHERN_MODE_DEFAULT（初期モード：殲滅）
* HERO_AI_REACTION_SPEED（キャシャーンが状況に反応する頻度）

---

### 3-5. シミュレーション／表示系

* SIMULATION_SPEED（1 tick あたりの経過時間倍率）
* MAX_SIMULATION_TIME（上限時間。将来、タイムアウトで強制終了）
* RANDOM_SEED（乱数シード：再現性確保用）

---

### 3-6. 地形・適性系（将来用）

* TERRAIN_TYPES（地形種類のテーブル）
* UNIT_TERRAIN_AFFINITY_PRESET

  * ユニット種別ごとの地形得手不得手
  * v0では未使用だが構造だけ作っておく

---

## 4. 「他になにかあるかな？」へのタルモン回答

**SAレベルで押さえておくと後で効いてくるパラメタ**としては、上の中で特に：

* ユニット数関係
* ステータス補正（攻撃・防御・キャシャーン倍率）
* 人類テック進化速度
* アンドロ／人類のAI性格パラメタ（攻撃性・結束度）
* シミュレーション速度・乱数シード

このへんを
**「UIからいじれるパラメタ」** として設計しておくと、
あとでシミュレーションとしても、ゲームとしても、かなり遊びやすくなると思う。

---

## 5. 次に詰めたいところ（質問セット）

### ❓ 次-Q1：

**UI（画面）から直接いじれる“最優先パラメタ”を、5〜7個に絞るならどれ？**

候補の中から：

* ANDRO_UNIT_COUNT
* HUMAN_UNIT_COUNT
* HUMAN_TECH_SPEED
* ANDRO_ATTACK_MULTIPLIER
* HUMAN_ATTACK_MULTIPLIER
* CASSHERN_POWER_MULTIPLIER
* SIMULATION_SPEED
* ANDRO_AGGRESSIVENESS
* HUMAN_COHESION_LEVEL

あたりが有力だと思ってるんだけど、
「ここは絶対スライダー or 入力欄で触りたい」というのを選んでほしい。

---

### ❓ 次-Q2：

**小隊の見た目はどうする？**

* A. 完全に「個体の集まり」のまま表示（内部だけ小隊扱い）
* B. 小隊ごとに、なんとなく“塊感”が分かる描画をしたい

  * 例：小隊長のブロックだけ枠を付ける／光らせる など

SAで「視覚的に小隊を意識するかどうか」を決めておきたい。

