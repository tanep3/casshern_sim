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

@group(0) @binding(0) var<storage, read_write> units: array<UnitData>;

struct GlobalUniforms {
    delta_time: f32,
    tick: u32,
    ai_interval: u32,
    human_phase: u32,
    casshern_mode: u32,
    player_input_active: u32,
    player_target: vec2<f32>,
    map_size: vec2<f32>,
    grid_size: f32,
    _pad1: u32,
    _pad2: vec4<u32>,
}

@group(0) @binding(1) var<uniform> globals: GlobalUniforms;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= arrayLength(&units)) {
        return;
    }

    // Placeholder logic
    var unit = units[index];
    unit.pos += unit.vel * globals.delta_time;
    
    // Boundary check
    if (unit.pos.x < 0.0 || unit.pos.x > globals.map_size.x) {
        unit.vel.x *= -1.0;
    }
    if (unit.pos.y < 0.0 || unit.pos.y > globals.map_size.y) {
        unit.vel.y *= -1.0;
    }

    units[index] = unit;
}
