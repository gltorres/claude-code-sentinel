.PHONY: validate test demo clean-demo refresh-data

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
	@mkdir -p demo
	@rm -f demo/audit.jsonl demo/transcript.md
	@CLAUDE_PLUGIN_DATA=$(CURDIR)/demo/ node tools/demo.mjs --write-transcript=demo/transcript.md
	@echo "demo: ok — transcript written to demo/transcript.md"

clean-demo:
	@rm -f demo/audit.jsonl demo/transcript.md
	@echo "clean-demo: ok"

refresh-data:
	@node tools/refresh_top_packages.mjs
