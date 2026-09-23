import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SessionScreenToggle } from '@/containers/SessionScreenPanel.js';

describe('SessionScreenToggle', () => {
  it('only shows from md up, where the Screen panel fits beside the chat', () => {
    const onToggle = vi.fn();
    render(<SessionScreenToggle open={false} onToggle={onToggle} />);
    const toggle = screen.getByRole('button', { name: 'Show screen' });
    expect(toggle).toHaveClass('hidden', 'md:inline-flex');
    expect(toggle).not.toHaveClass('inline-flex');

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
