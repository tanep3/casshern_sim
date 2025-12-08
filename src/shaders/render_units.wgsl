struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec3<f32>,
};

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

@group(0) @binding(0) var<storage, read> units: array<UnitData>;

@vertex
fn vs_main(
    @builtin(vertex_index) in_vertex_index: u32,
    @builtin(instance_index) in_instance_index: u32,
) -> VertexOutput {
    let unit = units[in_instance_index];
    
    // Simple quad vertices
    var pos = vec2<f32>(0.0, 0.0);
    if (in_vertex_index == 0u) { pos = vec2<f32>(-0.5, -0.5); }
    else if (in_vertex_index == 1u) { pos = vec2<f32>(0.5, -0.5); }
    else if (in_vertex_index == 2u) { pos = vec2<f32>(-0.5, 0.5); }
    else { pos = vec2<f32>(0.5, 0.5); } // 3u

    // Scale and translate
    let size = 5.0; // Pixel size
    let world_pos = unit.pos + pos * size;
    
    // Map to clip space (-1 to 1) assuming 800x600 resolution for now
    // In real implementation, pass screen size via uniform
    let screen_size = vec2<f32>(800.0, 600.0);
    let clip_pos = (world_pos / screen_size) * 2.0 - 1.0;

    var out: VertexOutput;
    out.clip_position = vec4<f32>(clip_pos.x, -clip_pos.y, 0.0, 1.0);
    
    // Color based on faction
    if (unit.faction == 0u) { out.color = vec3<f32>(1.0, 0.0, 0.0); } // Andro: Red
    else if (unit.faction == 1u) { out.color = vec3<f32>(0.0, 0.0, 1.0); } // Human: Blue
    else { out.color = vec3<f32>(1.0, 1.0, 1.0); } // Casshern: White

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}
