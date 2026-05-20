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
	src/nytrixDebugAdapter.js \
	snippets/nytrix.code-snippets \
	package.json package-lock.json language-configuration.json nshape-language-configuration.json \
	nytrix.tmLanguage.json nshape.tmLanguage.json markdown-nytrix.tmLanguage.json \
	README.md DETAILS.md LICENSE.md CHANGELOG.md logo.png

PACKAGE_FILES := src snippets package.json package-lock.json language-configuration.json nshape-language-configuration.json \
	nytrix.tmLanguage.json nshape.tmLanguage.json markdown-nytrix.tmLanguage.json \
	README.md DETAILS.md LICENSE.md CHANGELOG.md logo.png

all: $(VSIX)

deps:
	$(NPM) install

check:
	$(NPM) run check

$(VSIX): $(SOURCES)
	rm -rf $(PACKAGE_STAGE)
	mkdir -p $(PACKAGE_STAGE)
	cp -R $(PACKAGE_FILES) $(PACKAGE_STAGE)/
	cd $(PACKAGE_STAGE) && $(NPM) ci --omit=dev
	mkdir -p $(VSCE_PREFIX)
	cd $(PACKAGE_STAGE) && $(VSCE) package -o $(CURDIR)/$@

clean:
	rm -f -- *.vsix

.PHONY: all clean deps check
