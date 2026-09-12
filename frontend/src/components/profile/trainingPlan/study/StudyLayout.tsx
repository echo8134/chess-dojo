import { MenuOpen } from '@mui/icons-material';
import { Box, Drawer, IconButton, Stack, Theme, useMediaQuery } from '@mui/material';
import { ReactNode, useState } from 'react';

export interface StudyLayoutProps {
    breadcrumb: ReactNode;
    catalog: ReactNode;
    board: ReactNode;
    session: ReactNode;
}

const CATALOG_WIDTH = 300;

/** Breadcrumb over three panes; the catalog becomes a drawer below the medium breakpoint. */
export function StudyLayout({ breadcrumb, catalog, board, session }: StudyLayoutProps) {
    const wide = useMediaQuery((theme: Theme) => theme.breakpoints.up('md'));
    const [open, setOpen] = useState(false);

    return (
        <Box sx={{ px: { xs: 1, md: 2 }, py: 2 }}>
            <Stack direction='row' sx={{ alignItems: 'center', gap: 1, mb: 1 }}>
                {!wide && (
                    <IconButton onClick={() => setOpen(true)} aria-label='catalog'>
                        <MenuOpen />
                    </IconButton>
                )}
                {breadcrumb}
            </Stack>
            <Stack direction='row' sx={{ alignItems: 'flex-start', gap: 2 }}>
                {wide ? (
                    <Box sx={{ width: CATALOG_WIDTH, flexShrink: 0 }}>{catalog}</Box>
                ) : (
                    <Drawer open={open} onClose={() => setOpen(false)}>
                        <Box sx={{ width: CATALOG_WIDTH }} onClick={() => setOpen(false)}>
                            {catalog}
                        </Box>
                    </Drawer>
                )}
                <Stack sx={{ flexGrow: 1, minWidth: 0, gap: 2 }}>
                    {board}
                    {session}
                </Stack>
            </Stack>
        </Box>
    );
}
