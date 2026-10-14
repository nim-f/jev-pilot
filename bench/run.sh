#!/bin/zsh
# One benchmark run: a fresh copy of the todo app, one suite of prompts sent as
# one Claude Code session, with or without jev-pilot.
#
#   bench/run.sh <suite> <arm> <rep>     e.g.  bench/run.sh routine jev 1
#   suite: routine | followup | small-edit | feature   (bench/prompts/<suite>.txt)
#   arm:   opus (Claude Code alone) | jev (Claude Code + jev-pilot)
#
# Settings (environment): MODEL (claude-opus-5-5), EFFORT (high), BUDGET (1 USD per prompt).
#
# The opus arm doesn't use the mod, so it is a baseline kept in
# bench/baseline/<model>-<effort>/ and reused until its prompts change.
# The jev arm goes to bench/results/.
set -e
B=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$B")
APP=$ROOT/todo-app
MOD=$ROOT/jev-pilot
STORE=$HOME/.claude/plugins/store/jev-pilot_inline-3abb531a691c.json
MODEL=${MODEL:-claude-opus-5-5}
EFFORT=${EFFORT:-high}
BUDGET=${BUDGET:-1}

suite=$1 arm=$2 rep=$3
[[ -f $B/prompts/$suite.txt && ( $arm == opus || $arm == jev ) && -n $rep ]] || {
  echo "usage: bench/run.sh <routine|followup|small-edit|feature> <opus|jev> <rep>"; exit 1; }

if [[ $arm == jev ]]; then
  mode=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1])).get('mode','active'))" $STORE 2>/dev/null || echo active)
  [[ $mode == active ]] || { echo "jev-pilot mode is '$mode'. Run /jev active in Claude Code first."; exit 1; }
fi

if [[ $arm == opus ]]; then R=$B/baseline/$MODEL-$EFFORT/$suite-opus-$rep; else R=$B/results/$suite-jev-$rep; fi
if [[ -e $R ]]; then
  if [[ $arm == opus && -e $R/end-ms ]] && python3 -I $B/same-prompts.py $B/prompts/$suite.txt $R; then
    echo "[$suite/opus/$rep] baseline reused"; exit 0
  fi
  if [[ $arm == opus ]]; then
    echo "[$suite/opus/$rep] prompts changed or run unfinished: running the baseline again"; rm -rf $R
  elif [[ -e $R/end-ms ]]; then
    echo "[$suite/jev/$rep] already done (delete bench/results to start over)"; exit 0
  else
    echo "[$suite/jev/$rep] unfinished: running again"; rm -rf $R
  fi
fi
mkdir -p $R

# The app at a git baseline, plus one small uncommitted change so "what changed?" has an answer.
rsync -a --exclude node_modules --exclude .jev "$APP/" "$R/app/"
(cd $R/app && git init -q && git add -A && git -c user.name=bench -c user.email=bench@local commit -qm base \
  && printf '\n// TODO: show a toast when a todo is added\n' >> app.js)

TOOLS=(Read Edit Write "Bash(npm test)" "Bash(npm test:*)" "Bash(node --test:*)" "Bash(git status:*)"
       "Bash(git diff:*)" "Bash(git log:*)" "Bash(grep:*)" "Bash(ls:*)" "Bash(cat:*)")
plugin=(); [[ $arm == jev ]] && plugin=(--plugin-dir $MOD)

# Prompts are separated by a line with just ---.
python3 -I -c "
import sys,pathlib
for i,p in enumerate(pathlib.Path(sys.argv[1]).read_text().split('\n---\n'),1):
    pathlib.Path(sys.argv[2],f'prompt-{i}.txt').write_text(p.strip())
" $B/prompts/$suite.txt $R

echo "$(python3 -c 'import time;print(int(time.time()*1000))')" > $R/start-ms
sid="" resume=()
for p in $R/prompt-*.txt(n); do
  n=${${p:t:r}#prompt-}
  echo "[$suite/$arm/$rep] prompt $n: $(head -c 60 $p)"
  t0=$(python3 -c 'import time;print(time.time())')
  (cd $R/app && claude -p "$(cat $p)" --output-format json --model $MODEL --effort $EFFORT \
     --permission-mode acceptEdits --max-budget-usd $BUDGET --allowedTools "${TOOLS[@]}" \
     "${resume[@]}" "${plugin[@]}" > $R/result-$n.json 2> $R/result-$n.err) || true
  python3 -c "import time,sys;print(round(time.time()-float(sys.argv[1]),2))" $t0 > $R/wall-$n.txt
  if [[ -z $sid ]]; then
    sid=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['session_id'])" $R/result-$n.json)
    resume=(--resume $sid)
  fi
done
echo "$(python3 -c 'import time;print(int(time.time()*1000))')" > $R/end-ms

# Quality: do the tests still pass, and what did the session change?
(cd $R/app && npm test > $R/tests.txt 2>&1 && echo pass > $R/tests-status || echo fail > $R/tests-status)
(cd $R/app && git status --short > $R/changes.txt && git diff > $R/changes.diff)
echo "done: $R (tests $(cat $R/tests-status))"
