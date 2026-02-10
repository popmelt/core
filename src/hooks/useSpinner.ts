import { useEffect, useState } from 'react';

const SPINNER_FRAME_COUNT = 3;
const SPINNER_INTERVAL = 250;

const THINKING_WORDS = [
  'reviewing', 'considering', 'thinking', 'zhuzhing',
  'iterating', 'tweaking', 'reflecting', 'noodling',
  'pondering', 'finessing', 'polishing', 'riffing',
];
const WORD_INTERVAL = 3000;

export function useSpinner(active: boolean) {
  const [charIndex, setCharIndex] = useState(0);
  const [wordIndex, setWordIndex] = useState(() => Math.floor(Math.random() * THINKING_WORDS.length));

  useEffect(() => {
    if (!active) return;
    const charTimer = setInterval(() => setCharIndex(i => (i + 1) % SPINNER_FRAME_COUNT), SPINNER_INTERVAL);
    const wordTimer = setInterval(() => setWordIndex(i => (i + 1) % THINKING_WORDS.length), WORD_INTERVAL);
    return () => { clearInterval(charTimer); clearInterval(wordTimer); };
  }, [active]);

  return { charIndex, word: THINKING_WORDS[wordIndex]! };
}
