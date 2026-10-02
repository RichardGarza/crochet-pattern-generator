#!/bin/zsh
# usage: merge-check.sh <branch> "<merge message>" [e2e]
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo ~/projects/crochet-pattern-generator)" || exit 1
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null
git merge --no-ff -q "$1" -m "$2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || { echo "MERGE CONFLICT"; exit 1; }
echo merged
npm run typecheck >/tmp/cpg-tc.log 2>&1 || { echo "TYPECHECK FAILED"; grep "error TS" /tmp/cpg-tc.log | head; exit 1; }
npm run lint >/tmp/cpg-lint.log 2>&1 || { echo "LINT FAILED"; tail -15 /tmp/cpg-lint.log; exit 1; }
npm run build >/tmp/cpg-build.log 2>&1 || { echo "BUILD FAILED"; tail -15 /tmp/cpg-build.log; exit 1; }
npm test >/tmp/cpg-test.log 2>&1
if [ $? -ne 0 ]; then
  files=($(grep -E "^ FAIL" /tmp/cpg-test.log | awk '{print $2}' | sort -u))
  echo "full run failed in ${#files[@]} file(s) at load $(uptime | sed 's/.*averages: //'); re-running them alone: ${files[*]}"
  npm test -- ${files[@]} >/tmp/cpg-test-alone.log 2>&1 || { echo "REAL TEST FAILURE (fails alone too)"; grep -E "^ FAIL|Tests " /tmp/cpg-test-alone.log | head; exit 1; }
  echo "they pass alone: $(grep -E 'Tests ' /tmp/cpg-test-alone.log)"
fi
grep -E "Test Files|Tests " /tmp/cpg-test.log
if [ "$3" = "e2e" ]; then
  (npm run e2e >/tmp/cpg-e2e.log 2>&1 || npm run e2e >/tmp/cpg-e2e.log 2>&1) || { echo "E2E FAILED"; grep -E "✘|failed" /tmp/cpg-e2e.log | head; exit 1; }
  grep -E "passed|failed" /tmp/cpg-e2e.log | tail -1
fi
git push -q && echo pushed
