
export async function runTests(
    device: GPUDevice,
    unitBuffer: GPUBuffer,
    statsBuffer: GPUBuffer,
    uniformBuffer: GPUBuffer,
    reducePipeline: GPUComputePipeline,
    reduceBindGroup: GPUBindGroup,
    computePipeline: GPUComputePipeline,
    computeBindGroup: GPUBindGroup,
    gridBuildPipeline: GPUComputePipeline,
    gridBuildBindGroup: GPUBindGroup,
    gridCountBuffer: GPUBuffer,
    numUnits: number
) {
    console.log("%c=== Running WebGPU Tests ===", "color: yellow; font-weight: bold; font-size: 16px;");

    try {
        await testReduction(device, unitBuffer, statsBuffer, uniformBuffer, reducePipeline, reduceBindGroup, numUnits);
        await testCombat(device, unitBuffer, uniformBuffer, gridCountBuffer, gridBuildPipeline, gridBuildBindGroup, computePipeline, computeBindGroup, numUnits);
        console.log("%cAll Tests Passed!", "color: lime; font-weight: bold; font-size: 16px;");
    } catch (e) {
        console.error("%cTest Failed!", "color: red; font-weight: bold; font-size: 16px;", e);
    }
}

async function testReduction(
    device: GPUDevice,
    unitBuffer: GPUBuffer,
    statsBuffer: GPUBuffer,
    uniformBuffer: GPUBuffer,
    reducePipeline: GPUComputePipeline,
    reduceBindGroup: GPUBindGroup,
    numUnits: number
) {
    console.log("Running Reduction Test...");

    // 1. Prepare Test Data (3 units)
    const unitSize = 64;
    const testData = new ArrayBuffer(numUnits * unitSize);
    const view = new DataView(testData);

    // Unit 0: Andro (Faction 0), HP 100, State 1
    let offset = 0 * unitSize;
    view.setInt32(offset + 16, 100, true); // hp
    view.setUint32(offset + 20, 1, true);  // state
    view.setUint32(offset + 24, 0, true);  // faction

    // Unit 1: Human (Faction 1), HP 50, State 1
    offset = 1 * unitSize;
    view.setInt32(offset + 16, 50, true);  // hp
    view.setUint32(offset + 20, 1, true);  // state
    view.setUint32(offset + 24, 1, true);  // faction

    // Unit 2: Dead Andro (Faction 0), HP 0, State 0
    offset = 2 * unitSize;
    view.setInt32(offset + 16, 0, true);   // hp
    view.setUint32(offset + 20, 0, true);  // state (DEAD)
    view.setUint32(offset + 24, 0, true);  // faction

    // Write to GPU
    device.queue.writeBuffer(unitBuffer, 0, testData);

    // 2. Clear Stats Buffer
    const zeroBuffer = new Int32Array(48 / 4).fill(0);
    device.queue.writeBuffer(statsBuffer, 0, zeroBuffer);

    // 3. Init Uniform Buffer
    const uniformData = new ArrayBuffer(64);
    const uniformView = new DataView(uniformData);
    uniformView.setUint32(40, numUnits, true); // num_units
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // 4. Run Compute Shader
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(reducePipeline);
    pass.setBindGroup(0, reduceBindGroup);
    pass.dispatchWorkgroups(Math.ceil(numUnits / 64));
    pass.end();

    // 5. Readback
    const readbackBuffer = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    encoder.copyBufferToBuffer(statsBuffer, 0, readbackBuffer, 0, 48);

    device.queue.submit([encoder.finish()]);

    // Wait for GPU
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const result = new Int32Array(readbackBuffer.getMappedRange());

    const androCount = result[0];
    const androHp = result[1];
    const humanCount = result[4];
    const humanHp = result[5];

    console.log(`Reduction Result: Andro=${androCount} (HP:${androHp}), Human=${humanCount} (HP:${humanHp})`);

    // 6. Verify
    if (androCount !== 1) throw new Error(`Andro Count mismatch: expected 1, got ${androCount}`);
    if (androHp !== 100) throw new Error(`Andro HP mismatch: expected 100, got ${androHp}`);
    if (humanCount !== 1) throw new Error(`Human Count mismatch: expected 1, got ${humanCount}`);
    if (humanHp !== 50) throw new Error(`Human HP mismatch: expected 50, got ${humanHp}`);

    readbackBuffer.unmap();
}

async function testCombat(
    device: GPUDevice,
    unitBuffer: GPUBuffer,
    uniformBuffer: GPUBuffer,
    gridCountBuffer: GPUBuffer,
    gridBuildPipeline: GPUComputePipeline,
    gridBuildBindGroup: GPUBindGroup,
    computePipeline: GPUComputePipeline,
    computeBindGroup: GPUBindGroup,
    numUnits: number
) {
    console.log("Running Combat Test...");

    // 1. Prepare Test Data (2 units at same position)
    const unitSize = 64;
    const testData = new ArrayBuffer(numUnits * unitSize);
    const view = new DataView(testData);

    // Unit 0: Andro (Faction 0), Pos(100, 100), HP 100
    let offset = 0 * unitSize;
    view.setFloat32(offset + 0, 100.0, true); // pos.x
    view.setFloat32(offset + 4, 100.0, true); // pos.y
    view.setInt32(offset + 16, 100, true);    // hp
    view.setUint32(offset + 20, 1, true);     // state
    view.setUint32(offset + 24, 0, true);     // faction

    // Unit 1: Human (Faction 1), Pos(100, 100), HP 50
    offset = 1 * unitSize;
    view.setFloat32(offset + 0, 100.0, true); // pos.x
    view.setFloat32(offset + 4, 100.0, true); // pos.y
    view.setInt32(offset + 16, 50, true);     // hp
    view.setUint32(offset + 20, 1, true);     // state
    view.setUint32(offset + 24, 1, true);     // faction

    device.queue.writeBuffer(unitBuffer, 0, testData);

    // 2. Init Uniforms (Ensure vision range is enough)
    const uniformData = new ArrayBuffer(64);
    const uniformView = new DataView(uniformData);
    uniformView.setFloat32(0, 0.016, true);   // delta_time
    uniformView.setUint32(4, 100, true);      // tick (ensure AI update)
    uniformView.setUint32(8, 1, true);        // ai_interval (update every frame)
    uniformView.setUint32(40, numUnits, true); // num_units
    uniformView.setFloat32(44, 50.0, true);   // vision_range
    uniformView.setInt32(48, 10, true);       // andro_dmg
    uniformView.setInt32(52, 10, true);       // human_dmg
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // 3. Clear Grid Counts
    // We need to clear grid counts before grid build
    // Assuming gridCountBuffer size is enough for 8x6 grid (48 cells)
    const zeroGrid = new Uint32Array(48).fill(0);
    device.queue.writeBuffer(gridCountBuffer, 0, zeroGrid);

    // 4. Run Pipelines
    const encoder = device.createCommandEncoder();

    // Grid Build
    const gridPass = encoder.beginComputePass();
    gridPass.setPipeline(gridBuildPipeline);
    gridPass.setBindGroup(0, gridBuildBindGroup);
    gridPass.dispatchWorkgroups(Math.ceil(numUnits / 64));
    gridPass.end();

    // Combat (Compute)
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(computePipeline);
    computePass.setBindGroup(0, computeBindGroup);
    computePass.dispatchWorkgroups(Math.ceil(numUnits / 64));
    computePass.end();

    // 5. Readback Unit Data
    const readbackBuffer = device.createBuffer({
        size: numUnits * unitSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    encoder.copyBufferToBuffer(unitBuffer, 0, readbackBuffer, 0, numUnits * unitSize);

    device.queue.submit([encoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const result = new DataView(readbackBuffer.getMappedRange());

    // Check Unit 0 (Andro) HP
    // Should be 100 - HumanDmg(10) = 90
    const androHp = result.getInt32(0 * unitSize + 16, true);

    // Check Unit 1 (Human) HP
    // Should be 50 - AndroDmg(10) = 40
    const humanHp = result.getInt32(1 * unitSize + 16, true);

    console.log(`Combat Result: AndroHP=${androHp}, HumanHP=${humanHp}`);

    if (androHp !== 90) throw new Error(`Andro HP mismatch: expected 90, got ${androHp}`);
    if (humanHp !== 40) throw new Error(`Human HP mismatch: expected 40, got ${humanHp}`);

    readbackBuffer.unmap();
}
