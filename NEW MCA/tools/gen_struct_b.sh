#!/bin/bash
TOOL="C:/Users/admin/AppData/Roaming/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/plugins/managed/image_generation/scripts/image_generation_tool.py"
OUT="/c/KARIM/mca/NEW MCA/client/assets/structures"
STYLE="modern military RTS game building sprite, top-down angled view from the south-east, photorealistic, weathered concrete and painted steel, desert military base architecture, warm sunlight from top-left, subtle dust, single isolated building, centered, crisp silhouette, transparent background"
nohup python "$TOOL" generate --description "Military oil depot: fuel storage farm with several large cylindrical tanks, pump house, pipeline manifold, small guard post, bund walls. $STYLE" --size 1024x1024 --background transparent --output "$OUT/SH-03.png" > /tmp/img_s03.log 2>&1 &
nohup python "$TOOL" generate --description "Military airfield: long concrete runway strip with taxiway, small control tower, hangar with open door showing jet inside, fuel bowsers. $STYLE" --size 1024x1024 --background transparent --output "$OUT/SH-06.png" > /tmp/img_s06.log 2>&1 &
nohup python "$TOOL" generate --description "Fortified machine-gun bunker nest: low concrete bunker with sandbag ring, firing slit, small radar dish on the roof, camo netting. $STYLE" --size 1024x1024 --background transparent --output "$OUT/SH-09.png" > /tmp/img_s09.log 2>&1 &
nohup python "$TOOL" generate --description "Anti-tank missile tower: elevated concrete platform with missile launcher tubes on a pivoting mount, ammo crate, rangefinder box. $STYLE" --size 1024x1024 --background transparent --output "$OUT/SH-10.png" > /tmp/img_s10.log 2>&1 &
echo "launched batch B"
