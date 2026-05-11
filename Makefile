.PHONY: validate test demo refresh-data

validate:
	@for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json hooks/sentinel.json src/sentinel/data/*.json; do \
		python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$$f" && echo "$$f: ok" || exit 1; \
	done
	@node --test tests/*.mjs
	@node src/sentinel/hook.mjs --self-test
	@echo "validate: ok"

test:
	@node --test tests/*.mjs

demo:
	@echo "demo not yet implemented (Sprint 10)"

refresh-data:
	@node tools/refresh_top_packages.mjs
