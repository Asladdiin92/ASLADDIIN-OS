export type Task = {
  id: string;
  url: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  area: string;
  course: string;
  courseCode?: string;
  estimatedHours?: number;
  actualHours?: number;
  assessment?: string;
  creditHours?: number;
  instructor?: string;
  peopleInstructor?: string[];
  peopleInstructorIds?: string[];
  marksGrade?: string;
  nextReviewDate?: string | null;
  notes?: string;
  recurrence?: string;
  resourceLink?: string;
  semester?: string;
  timeBlock?: string;
  venueLink?: string;
  nextAction: string;
  dueDate: string | null;
  dateEnd?: string | null;
  dateIsDateTime?: boolean;
  deliverable?: boolean;
  createdAt: string;
  updatedAt?: string;
  completed: boolean;
};

export type AIKnowledgeType =
  | "notion_task_shadow"
  | "ai_skill"
  | "research_note"
  | "file_excerpt";

export type AIKnowledgeMetadataValue = string | number | boolean | null;

export type AIKnowledgeMetadata = Record<string, AIKnowledgeMetadataValue>;

export type AIKnowledgeItemInput = {
  type: Exclude<AIKnowledgeType, "notion_task_shadow">;
  title: string;
  content: string;
  metadata?: AIKnowledgeMetadata;
};

export type AIKnowledgeSearchResult = {
  title: string;
  content: string;
  type: AIKnowledgeType;
  sourceId?: string;
  area?: string;
  courseCode?: string;
  score: number;
};

export type TaskOptions = {
  types: string[];
  statuses: string[];
  priorities: string[];
  areas: string[];
  courses: string[];
  assessments: string[];
  semesters: string[];
  availableFields: string[];
};

export type TasksResponse = {
  tasks: Task[];
  configured: boolean;
  options?: TaskOptions;
  error?: string;
};
