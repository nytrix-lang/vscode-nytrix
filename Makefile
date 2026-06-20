.POSIX:
.SUFFIXES:
PUBLISHER != jq -r .publisher package.json
NAME != jq -r .name package.json
VERSION != jq -r .version package.json
VSIX = $(PUBLISHER).$(NAME)-$(VERSION).vsix
NPM ?= npm
VSCE_VERSION != node -p "require('./package-lock.json').packages['node_modules/@vscode/vsce'].version"
VSCE_PREFIX ?= /tmp/nytrix-vsce
VSCE ?= npx --prefix $(VSCE_PREFIX) --yes --package @vscode/vsce@$(VSCE_VERSION) vsce
PACKAGE_STAGE ?= /tmp/nytrix-vscode-package

SOURCES := \
	src/extension.js \
	etc/snippets/nytrix.code-snippets \
	etc/snippets/nshape.code-snippets \
	etc/syntax/language-configuration.json \
	etc/syntax/nshape-language-configuration.json \
	etc/syntax/shader-language-configuration.json \
	etc/syntax/nytrix.tmLanguage.json \
	etc/syntax/nshape.tmLanguage.json \
	etc/syntax/shader.tmLanguage.json \
	etc/syntax/markdown-nytrix.tmLanguage.json \
	.vscodeignore package.json package-lock.json \
	README.md LICENSE logo.png

PACKAGE_FILES := src etc logo.png .vscodeignore package.json package-lock.json \
	README.md LICENSE

all: $(VSIX)

help:
	@echo "Nytrix VS Code Extension Build System"
	@echo "-------------------------------------"
	@echo "make test    - Run all tests (smoke, UI, protocol) via test.py"
	@echo "make check   - Run syntax and basic checks"
	@echo "make package - Build the .vsix package"

deps:
	$(NPM) install

check:
	$(NPM) run check

test:
	python3 etc/scripts/tests/test.py smoke

package: $(VSIX)

$(VSIX): $(SOURCES)
	rm -rf $(PACKAGE_STAGE) $(VSCE_PREFIX)
	mkdir -p $(PACKAGE_STAGE)
	cp -R $(PACKAGE_FILES) $(PACKAGE_STAGE)/
	cd $(PACKAGE_STAGE) && $(NPM) ci --omit=dev
	mkdir -p $(VSCE_PREFIX)
	cd $(PACKAGE_STAGE) && $(VSCE) package -o $(CURDIR)/$@
	rm -rf $(PACKAGE_STAGE) $(VSCE_PREFIX)

clean:
	rm -f -- *.vsix
	rm -rf $(PACKAGE_STAGE) $(VSCE_PREFIX)

.PHONY: all clean deps check help test package
