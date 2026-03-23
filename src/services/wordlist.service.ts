import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWordlist(filename: string): string[] {
  const filePath = join(__dirname, '..', 'wordlists', filename);
  const words = readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(w => w.trim())
    .filter(w => w.length > 0);
  if (words.length === 0) {
    throw new Error(`Wordlist ${filename} is empty`);
  }
  return words;
}

let adjectives: string[];
let nouns: string[];

export function initWordlist(): void {
  adjectives = loadWordlist('adjectives.txt');
  nouns = loadWordlist('nouns.txt');
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function generateNickname(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${capitalize(adj)} ${capitalize(noun)}`;
}
