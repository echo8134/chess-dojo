import { Check, ExpandMore } from '@mui/icons-material';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Button,
    List,
    ListItemButton,
    ListItemText,
    Stack,
    Typography,
} from '@mui/material';
import { useTranslations } from 'next-intl';
import { useLocalStorage } from 'usehooks-ts';
import { StudyBook, StudyChapter, StudyItem } from './book';

export interface StudyCatalogProps {
    book: StudyBook;
    current: StudyItem;
    done: Set<string>;
    workedOn: Set<string>;
    historyComplete: boolean;
    onSelect: (item: StudyItem) => void;
}

/** The book's chapters and games. A chapter with one game is a plain row; more get an accordion. */
export function StudyCatalog({
    book,
    current,
    done,
    workedOn,
    historyComplete,
    onSelect,
}: StudyCatalogProps) {
    const t = useTranslations('study.catalog');
    const [closed, setClosed] = useLocalStorage<string[]>(`study.closed.${book.title}`, []);
    const multi = book.chapters.filter((chapter) => chapter.items.length > 1);
    const allOpen = multi.every((chapter) => !closed.includes(chapter.name));
    const total = book.chapters.reduce((n, chapter) => n + chapter.items.length, 0);
    const doneCount = book.chapters
        .flatMap((chapter) => chapter.items)
        .filter((item) => done.has(item.key)).length;

    let number = 0;
    const row = (item: StudyItem) => {
        number += 1;
        const selected = item.key === current.key;
        return (
            <ListItemButton
                key={item.key}
                selected={selected}
                onClick={() => onSelect(item)}
                data-testid='study-item'
                data-item-key={item.key}
                sx={{
                    borderLeft: 3,
                    borderColor: selected ? 'primary.main' : 'transparent',
                    py: 0.75,
                }}
            >
                <Typography sx={{ width: 28, color: 'text.secondary', flexShrink: 0 }}>
                    {number}
                </Typography>
                <ListItemText
                    primary={item.name}
                    slotProps={{
                        primary: {
                            sx: {
                                fontWeight: workedOn.has(item.key) ? 600 : undefined,
                            },
                        },
                    }}
                />
                {done.has(item.key) && (
                    <Check color='success' fontSize='small' data-testid='study-item-done' />
                )}
            </ListItemButton>
        );
    };

    const chapter = (c: StudyChapter, index: number) => {
        if (c.items.length === 1) {
            return row(c.items[0]);
        }
        const open = !closed.includes(c.name);
        return (
            <Accordion
                key={`${index}-${c.name}`}
                expanded={open}
                onChange={(_, expanded) =>
                    setClosed(
                        expanded ? closed.filter((name) => name !== c.name) : [...closed, c.name],
                    )
                }
                disableGutters
                elevation={0}
                square
            >
                <AccordionSummary expandIcon={<ExpandMore />}>
                    <Typography>{c.name}</Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                    <List disablePadding>{c.items.map(row)}</List>
                </AccordionDetails>
            </Accordion>
        );
    };

    return (
        <Stack data-testid='study-catalog' sx={{ minWidth: 0 }}>
            <Stack sx={{ px: 2, pb: 1 }}>
                <Typography variant='h6'>{book.title}</Typography>
                <Typography variant='body2' sx={{ color: 'text.secondary' }}>
                    {t('studied', { done: doneCount, total })}
                </Typography>
                {!historyComplete && (
                    <Typography variant='caption' sx={{ color: 'text.secondary' }}>
                        {t('historyLoading')}
                    </Typography>
                )}
                {book.skipped > 0 && (
                    <Typography variant='caption' sx={{ color: 'text.secondary' }}>
                        {t('skipped', { count: book.skipped })}
                    </Typography>
                )}
                {multi.length > 0 && (
                    <Button
                        size='small'
                        sx={{ alignSelf: 'flex-start', mt: 0.5 }}
                        onClick={() =>
                            setClosed(allOpen ? multi.map((chapter) => chapter.name) : [])
                        }
                    >
                        {allOpen ? t('collapseAll') : t('expandAll')}
                    </Button>
                )}
            </Stack>
            <List disablePadding>{book.chapters.map(chapter)}</List>
        </Stack>
    );
}
