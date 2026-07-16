Open-game approximation research (parked)
=========================================

Experiments toward fast near-Nash for rem > 7 via one-ply open policies
(rollout / ridge / MLP leaves) and latency–gap Pareto curves.

This is NOT part of the production solver path (gops/nash, gops/play).
Core exact Nash stays under gops/nash/.

Layout
------
  open_policy.py          depth-d open + Numba rollout leaves
  leaf_reg.py / leaf_mlp.py   learned leaves (MAE gate failed ~0.13)
  scripts/                eval / train harnesses
  artifacts/              Pareto CSVs + saved leaf weights

Key result so far
-----------------
  rem=7 depth-1 rollout ~4–6% mean one-step exploit gap @ few ms.
  MLP rem=6 leaf MAE ~0.13 (need ≤0.05 for ~1–2% open gap) — parked.
  Exact rem≤7 on-demand remains the production path for endgame.

Run examples
------------
  python build/gops/research/open_approx/scripts/eval_open_pareto.py --K 7 --samples 12
  python build/gops/research/open_approx/scripts/eval_basic_leaves.py --K 7 --samples 16
