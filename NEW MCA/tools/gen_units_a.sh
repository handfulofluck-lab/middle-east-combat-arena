#!/bin/bash
TOOL="C:/Users/admin/AppData/Roaming/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/plugins/managed/image_generation/scripts/image_generation_tool.py"
OUT="/c/KARIM/mca/NEW MCA/client/assets/units"
mkdir -p "$OUT"
STYLE="modern military RTS game unit sprite, top-down angled view from the south-east, photorealistic, desert tan camouflage, single isolated subject, centered, crisp silhouette, transparent background"
nohup python "$TOOL" generate --description "Modern main battle tank with desert camo, turret facing north-east, reactive armor blocks, detailed tracks. $STYLE" --size 1024x1024 --background transparent --output "$OUT/mbt.png" > /tmp/img_mbt.log 2>&1 &
nohup python "$TOOL" generate --description "Squad of four modern infantry soldiers in desert camouflage standing in loose formation, rifles held low, top-down view. $STYLE" --size 1024x1024 --background transparent --output "$OUT/infantry.png" > /tmp/img_inf.log 2>&1 &
nohup python "$TOOL" generate --description "Modern attack helicopter with desert camo, stub wings with missile pods, rotor blades, facing north-east. $STYLE" --size 1024x1024 --background transparent --output "$OUT/attack_helo.png" > /tmp/img_helo.log 2>&1 &
nohup python "$TOOL" generate --description "Modern fighter jet with desert camo, delta wings, viewed from above at an angle, facing north-east. $STYLE" --size 1024x1024 --background transparent --output "$OUT/fighter.png" > /tmp/img_ftr.log 2>&1 &
echo "launched unit batch A"
