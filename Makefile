.POSIX:
.SUFFIXES:
PUBLISHER != jq -r .publisher package.json
NAME != jq -r .name package.json
VERSION != jq -r .version package.json
VSIX = $(PUBLISHER).$(NAME)-$(VERSION).vsix

SOURCES := \
	package.json language-configuration.json nytrix.tmLanguage.json \
	README.md LICENSE.md CHANGELOG.md

all: $(VSIX)

$(VSIX): $(SOURCES)
	vsce package -o $@

clean:
	rm *.vsix

.PHONY: clean
