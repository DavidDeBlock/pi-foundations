/**
 * Explicit TypeScript interfaces for staff members (users).
 * Mirrors the DB schema's `users` table but is decoupled from Drizzle inference.
 */

export interface StaffMember {
  id: string
  name: string
  role: 'mechanic' | 'manager'
  hourlyRate: number // cents per hour
  isActive: boolean
  createdAt: Date
}

/** Input for creating a new staff member. */
export interface NewStaffMember {
  name: string
  role: 'mechanic' | 'manager'
  hourlyRate: number // cents per hour
  isActive?: boolean
}

/** Input for updating an existing staff member (partial). */
export interface UpdateStaffMember {
  name?: string
  role?: 'mechanic' | 'manager'
  hourlyRate?: number // cents per hour
  isActive?: boolean
}

/** Aggregated performance statistics for a single staff member. */
export interface StaffStats {
  /** Total minutes worked from completed work log timers (endedAt IS NOT NULL) */
  totalHoursWorked: number
  /** Count of repairs assigned to this user with status = 'completed' */
  completedRepairs: number
  /** Count of repairs assigned to this user where status is NOT 'completed' or 'cancelled' */
  activeRepairs: number
  /** Average repair duration in minutes (totalHoursWorked / completedRepairs), null if no completions */
  avgRepairDurationMinutes: number | null
}
