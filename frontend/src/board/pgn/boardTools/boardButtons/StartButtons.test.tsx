import { ChessContext } from '@/board/pgn/PgnBoard';
import { renderWithIntl } from '@/i18n/intl.test';
import { Chess } from '@jackstenglein/chess';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import StartButtons from './StartButtons';

function renderMenu(disableExport: boolean) {
    const value = { chess: new Chess(), config: { disableExport } };
    renderWithIntl(
        <ChessContext.Provider value={value}>
            <StartButtons />
        </ChessContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button'));
}

describe('StartButtons', () => {
    afterEach(() => {
        cleanup();
    });

    it('offers Copy PGN when the game may be exported', () => {
        renderMenu(false);
        expect(screen.getByRole('menuitem', { name: 'Copy PGN' })).toBeTruthy();
    });

    it('hides Copy PGN when the course disables export', () => {
        renderMenu(true);
        expect(screen.queryByRole('menuitem', { name: 'Copy PGN' })).toBeNull();
        expect(screen.getByRole('menuitem', { name: 'Copy FEN' })).toBeTruthy();
    });
});
