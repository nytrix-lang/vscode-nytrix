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

LANGUAGE_FILES != find language -type f
SOURCES := src/extension.js package.json package-lock.json $(LANGUAGE_FILES)
PACKAGE_FILES := src language logo.png .vscodeignore package.json package-lock.json \
	README.md CHANGELOG.md LICENSE

all: $(VSIX)

help:
	@echo "Nytrix VS Code Extension Build System"
	@echo "-------------------------------------"
	@echo "make check   - Validate the manifest, assets, commands and settings"
	@echo "make sync    - Regenerate the package.json sections from language/"
	@echo "make package - Build the .vsix package"

deps:
	$(NPM) install

check:
	$(NPM) run check

sync:
	$(NPM) run sync

test:
	$(NPM) run check

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

.PHONY: all clean deps check sync test package help
