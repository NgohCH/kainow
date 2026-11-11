/** Whether automatic analysis is on for a project (spec 7.7). Task 9 binds the real settings reader. */
export interface AutomaticAnalysis {
  isOn(projectId: string): Promise<boolean>;
}
export const AUTOMATIC_ANALYSIS = Symbol('AUTOMATIC_ANALYSIS');
export const ALWAYS_AUTOMATIC: AutomaticAnalysis = { isOn: async () => true };
