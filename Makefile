.PHONY: validate test demo

validate:
	@node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'))" \
	  && echo "plugin.json: ok"
	@node -e "JSON.parse(require('fs').readFileSync('hooks/sentinel.json','utf8'))" \
	  && echo "hooks/sentinel.json: ok"
	@node --test tests/*.mjs
	@node src/sentinel/hook.mjs --self-test
	@echo "validate: ok"

test:
	@node --test tests/*.mjs

demo:
	@echo "demo not yet implemented (Sprint 10)"
