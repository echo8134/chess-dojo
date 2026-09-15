import { GetCourseResponse } from '@/api/courseApi';
import { Course } from '@/database/course';
import { AxiosResponse } from 'axios';

/**
 * Courses fetched during this page load. What the overview read ahead is what the study page opens.
 */
const courses = new Map<string, Course>();

interface CourseApi {
    getCourse: (type: string, id: string) => Promise<AxiosResponse<GetCourseResponse>>;
}

export async function loadCourse(
    api: CourseApi,
    type: string,
    id: string,
): Promise<GetCourseResponse> {
    const key = `${type}/${id}`;
    const hit = courses.get(key);
    if (hit) {
        return { course: hit, isBlocked: false };
    }
    const resp = await api.getCourse(type, id);
    if (!resp.data.isBlocked && resp.data.course) {
        courses.set(key, resp.data.course);
    }
    return resp.data;
}

export function cachedCourse(type: string, id: string): Course | undefined {
    return courses.get(`${type}/${id}`);
}

export function clearCourseCache() {
    courses.clear();
}
