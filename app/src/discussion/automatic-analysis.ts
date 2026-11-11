/** Whether automatic analysis is on for a project (spec 7.7). The real reader is bound in AnalysisModule. */
export interface AutomaticAnalysis {
  isOn(projectId: string): Promise<boolean>;
}
export const AUTOMATIC_ANALYSIS = Symbol('AUTOMATIC_ANALYSIS');
