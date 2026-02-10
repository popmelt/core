import { useEffect, useRef } from 'react';

export type ModifierState = { shift: boolean; cmd: boolean };

export function useModifierKeys() {
  const ref = useRef<ModifierState>({ shift: false, cmd: false });

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') ref.current.shift = true;
      if (e.key === 'Meta' || e.key === 'Control') ref.current.cmd = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') ref.current.shift = false;
      if (e.key === 'Meta' || e.key === 'Control') ref.current.cmd = false;
    };
    const blur = () => { ref.current = { shift: false, cmd: false }; };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return ref;
}
