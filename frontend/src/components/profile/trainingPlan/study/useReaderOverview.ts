import { useApi } from '@/api/Api';
import { useCache } from '@/api/cache/Cache';
import { useRequirements } from '@/api/cache/requirements';
import { Request, useRequest } from '@/api/Request';
import { AuthStatus, useAuth } from '@/auth/Auth';
import { Course } from '@/database/course';
import { hasMaterial } from '@/database/requirement';
import { TimelineEntry } from '@/database/timeline';
import { ALL_COHORTS, User } from '@/database/user';
import { useEffect, useMemo, useRef, useState } from 'react';
import { concatBooks, courseBook, itemsOf, StudyBook } from './book';
import { loadCourse } from './courseCache';
import { buildOverview, OverviewModel } from './overview';
import { isWorkbook, taskCohort } from './selectors';

/** Older timeline pages read for a set's last study entry before the page gives up on it. */
const TIMELINE_PAGE_CAP = 20;

export type ReaderOverviewState =
    | { status: 'loading' }
    | { status: 'error'; request: Request<never> }
    | {
          status: 'ready';
          user: User;
          model: OverviewModel;
          /** The cohort the page shows. The member's own until switched, and again on every visit. */
          viewCohort: string;
          setViewCohort: (cohort: string) => void;
      };

/** Loads the overview's inputs once and rebuilds the model when one changes. Reads ahead the next item's book. */
export function useReaderOverview(): ReaderOverviewState {
    const api = useApi();
    const cache = useCache();
    const { user, status: authStatus } = useAuth();
    const { requirements, request: requirementsRequest } = useRequirements(ALL_COHORTS, false);
    const request = useRequest<never>();
    const [courses, setCourses] = useState<Course[]>();
    const [entries, setEntries] = useState<TimelineEntry[]>();
    const [chosenCohort, setViewCohort] = useState<string>();
    // The books the walk has loaded, tagged with their walk. A stale walk's books are never shown.
    const [walked, setWalked] = useState<{ key: string; books: Map<string, StudyBook> }>();
    const username = user?.username;
    const viewCohort = chosenCohort ?? user?.dojoCohort ?? '';
    // Every user update rebuilds the api object; the effects read it through a ref and never rerun for it.
    const apiRef = useRef(api);
    apiRef.current = api;

    const allLoaded = cache.requirements.isFetched(ALL_COHORTS) && !requirementsRequest.isLoading();
    // The tasks whose last study entry decides the next item: the member's own cohort's sets. A
    // workbook takes its next from the pointer. Keyed by value so a refetched list does not repage.
    const studyTaskIds = JSON.stringify(
        allLoaded && user
            ? requirements
                  .filter(
                      (task) =>
                          hasMaterial(task) &&
                          !isWorkbook(task) &&
                          taskCohort(task, user) === user.dojoCohort,
                  )
                  .map((task) => task.id)
            : null,
    );

    const { onFailure } = request;
    useEffect(() => {
        if (!username) return;
        let cancelled = false;
        apiRef.current
            .listAllCourses()
            .then((list) => {
                if (!cancelled) setCourses(list);
            })
            .catch((err: unknown) => {
                if (!cancelled) onFailure(err);
            });
        return () => {
            cancelled = true;
        };
    }, [username, onFailure]);

    // The newest page paints the page. Older pages follow until every set has its last study
    // entry, the timeline ends, or the cap is reached, so Continue does not forget where the
    // member was.
    useEffect(() => {
        const taskIds = JSON.parse(studyTaskIds) as string[] | null;
        if (!username || !taskIds) return;
        let cancelled = false;
        const load = async () => {
            const missing = new Set(taskIds);
            const loaded: TimelineEntry[] = [];
            let startKey: string | undefined;
            let pages = 0;
            do {
                const resp = await apiRef.current.listUserTimeline(username, startKey);
                if (cancelled) return;
                loaded.push(...resp.entries);
                setEntries([...loaded]);
                for (const entry of resp.entries) {
                    if (entry.studyInfo) missing.delete(entry.requirementId);
                }
                startKey = resp.lastEvaluatedKey || undefined;
                pages += 1;
            } while (startKey && missing.size > 0 && pages < TIMELINE_PAGE_CAP);
        };
        load().catch((err: unknown) => {
            if (!cancelled) onFailure(err);
        });
        return () => {
            cancelled = true;
        };
    }, [username, studyTaskIds, onFailure]);

    const base = useMemo(
        () =>
            user && courses && entries && allLoaded
                ? buildOverview({ user, requirements, courses, entries, viewCohort })
                : undefined,
        [user, requirements, courses, entries, allLoaded, viewCohort],
    );

    // The books behind the cohort studies. A set is read whole, for the next item's name. A
    // workbook is read part by part only as far as the pointer, to warm the cache the study
    // page opens from. The key is by value, so a refreshed user record does not refetch.
    const walkKey = JSON.stringify(
        (base?.cohortStudies ?? []).map((study) => ({
            id: study.task.id,
            material: study.task.material,
            need: isWorkbook(study.task) ? study.done + 1 : Infinity,
        })),
    );
    useEffect(() => {
        const studies = JSON.parse(walkKey) as {
            id: string;
            material: NonNullable<OverviewModel['cohortStudies'][number]['task']['material']>;
            need: number | null;
        }[];
        let cancelled = false;
        const walk = async () => {
            for (const study of studies) {
                const parts: StudyBook[] = [];
                for (const material of study.material) {
                    if (material.kind !== 'COURSE') continue;
                    const data = await loadCourse(
                        apiRef.current,
                        material.courseType,
                        material.courseId,
                    );
                    if (cancelled) return;
                    if (data.isBlocked || !data.course) break;
                    parts.push(courseBook(data.course));
                    const book = concatBooks(data.course.name, parts);
                    setWalked((prev) => ({
                        key: walkKey,
                        books: new Map(prev?.key === walkKey ? prev.books : []).set(study.id, book),
                    }));
                    // JSON turned Infinity into null. That marks a set, which reads every part.
                    if (study.need !== null && itemsOf(book).length >= study.need) break;
                }
            }
        };
        walk().catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [walkKey]);

    const books = walked?.key === walkKey ? walked.books : undefined;
    const model = useMemo(
        () =>
            user && courses && entries && base
                ? buildOverview({ user, requirements, courses, entries, viewCohort, books })
                : undefined,
        [user, requirements, courses, entries, base, viewCohort, books],
    );

    if (request.isFailure()) return { status: 'error', request };
    if (requirementsRequest.isFailure()) return { status: 'error', request: requirementsRequest };
    if (authStatus === AuthStatus.Loading || !user) return { status: 'loading' };
    if (!model) return { status: 'loading' };
    return { status: 'ready', user, model, viewCohort, setViewCohort };
}
