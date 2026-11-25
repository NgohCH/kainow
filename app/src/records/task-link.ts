/** The address of a task's own page (11a.1, D133). Other records keep their place on the Work tab. */
export const taskLink = (projectId: string, taskId: string): string => `#/projects/${projectId}/tasks/${taskId}`;
