#!/bin/zsh
# Quick by default: the routine and followup suites, 2 rounds, jev arm only;
# the opus baseline runs only when it's missing or its prompts changed.
# About 10 minutes and $1-2 once the baseline exists.
#
#   bench/run-all.sh                          quick
#   FULL=1 bench/run-all.sh                   every suite, 3 rounds
#   SUITES="routine" REPS=1 bench/run-all.sh  pick your own
#   FRESH_BASELINE=1 bench/run-all.sh         run the opus baseline again too
B=$(cd "$(dirname "$0")" && pwd)
if [[ -n $FULL ]]; then
  REPS=${REPS:-3}; SUITES=${SUITES:-routine followup small-edit feature}
else
  REPS=${REPS:-2}; SUITES=${SUITES:-routine followup}
fi
MODEL=${MODEL:-claude-opus-5-5} EFFORT=${EFFORT:-high}
[[ -n $FRESH_BASELINE ]] && for s in ${=SUITES}; do rm -rf $B/baseline/$MODEL-$EFFORT/$s-opus-*; done
for rep in $(seq 1 $REPS); do
  for suite in ${=SUITES}; do
    # Baseline and jev run side by side: the baseline doesn't touch the Jev log.
    MODEL=$MODEL EFFORT=$EFFORT $B/run.sh $suite opus $rep &
    MODEL=$MODEL EFFORT=$EFFORT $B/run.sh $suite jev $rep || echo "!! $suite jev $rep failed"
    wait
  done
done
mkdir -p $B/results
MODEL=$MODEL EFFORT=$EFFORT python3 $B/summary.py | tee $B/results/summary.md
