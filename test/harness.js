"use strict";

function fail(err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}

async function runAll(cases) {
  try {
    for (const [name, main] of cases) {
      await main();
      console.log(`${name}: ok`);
    }
  } catch (err) {
    fail(err);
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

function fileUri(filePath) {
  return {
    scheme: "file",
    fsPath: filePath,
    toString() {
      return filePath;
    }
  };
}

function document(filePath, text) {
  const lines = text.split(/\r?\n/);
  return {
    languageId: "nytrix",
    uri: fileUri(filePath),
    lineCount: lines.length,
    getText(range) {
      if (!range) return text;
      return range.start.line === range.end.line
        ? lines[range.start.line].slice(range.start.character, range.end.character)
        : "";
    },
    lineAt(index) {
      return { text: lines[index] };
    },
    getWordRangeAtPosition(position, regex = /[A-Za-z_][A-Za-z0-9_.]*/g) {
      const line = lines[position.line] || "";
      const word = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
      let match;
      while ((match = word.exec(line))) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character >= start && position.character <= end) {
          return new Range(position.line, start, position.line, end);
        }
      }
      return null;
    }
  };
}

module.exports = { runAll, Position, Range, fileUri, document };
