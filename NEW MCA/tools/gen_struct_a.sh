#!/bin/bash
TOOL="C:/Users/admin/AppData/Roaming/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/plugins/managed/image_generation/scripts/image_generation_tool.py"
OUT="/c/KARIM/mca/NEW MCA/client/assets/structures"
mkdir -p "$OUT"
STYLE="modern military RTS game building sprite, top-down angled view from the south-east, photorealistic, weathered concrete and painted steel, desert military base architecture, warm sunlight from top-left, subtle dust, single isolated building, centered, crisp silhouette, transparent background"
nohup python "$TOOL" generate --description "Large military construction yard complex: gantry cranes, stacked prefab concrete slabs, assembly halls, scattered building materials, low wide layout. $STYLE" --size 1024x1024 --background transparent --output "$OUT/SH-01.png" > /tmp/img_s01.log 2>&1 &
nohup python "$TOOL" generate --description "Military power plant: squat concrete turbine hall with cooling structures, exhaust stacks, high-voltage transformers and cable pylons, diesel generators. $STYLE" --size 1024x1024 --background transparent --output "$OUT/SH-02.png" > /tmp/img_s02.log 2>&1 &
nohup python "$TOOL" generate --description "Military barracks compound: single-story flat-roof dormitory blocks, sandbag positions at corners, small parade yard, flag pole, perimeter walls. $STYLE" --size 1024x1024 --background transparent --output "$OUT/SH-04.png" > /tmp/img_s04.log 2>&1 &
nohup python "$TOOL" generate --description "Military war factory: big armored vehicle assembly hall with wide sliding doors, welding rigs, tank turret on a crate outside, fuel drums, crane arm. $STYLE" --size 1024x1024 --background transparent --output "$OUT/SH-05.png" > /tmp/img_s05.log 2>&1 &
echo "launched batch A"
