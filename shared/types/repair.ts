/**
 * Explicit TypeScript interfaces for repair-related entities.
 * Mirrors the DB schema but is decoupled from Drizzle inference.
 * Both client and server import these as single source of truth.
 */

// ============================================================================
// Repair Status — lifecycle states
// ============================================================================

export type RepairStatus = 'intake' | 'in_progress' | 'on_hold' | 'verified' | 'ready' | 'completed' | 'cancelled'

/** Valid status transitions from a given source status */
export const VALID_TRANSITIONS: Record<RepairStatus, RepairStatus[]> = {
  intake: ['in_progress'],
  in_progress: ['on_hold', 'verified'],
  on_hold: ['in_progress'],
  verified: ['ready'],
  ready: ['completed'],
  completed: [], // terminal — no transitions allowed (except via cancel)
  cancelled: [], // terminal
}

/** All statuses that can be reached from any state */
export const CANCEL_TARGETS: RepairStatus[] = [
  'intake', 'in_progress', 'on_hold', 'verified', 'ready'
]

// ============================================================================
// Hold Reason — why a repair is paused
// ============================================================================

export type HoldReason = 'waiting_parts' | 'awaiting_customer_approval' | 'other'

// ============================================================================
// Repair Header
// ============================================================================

/** A repair record representing a bicycle service job */
export interface Repair {
  /** Unique identifier (client-generated UUID) */
  id: string
  /** Bicycle being serviced */
  bicycleId: string
  /** Assigned technician (NULL = unassigned, deferred dispatch) */
  assignedTo: string | null
  /** Current status in the lifecycle */
  status: RepairStatus
  /** Notes visible to customer */
  customerNotes: string | null
  /** Internal technician observations */
  internalNotes: string | null
  /** Reason for being on hold (requires note when set) */
  holdReason: HoldReason | null
  /** Explanation for the hold reason */
  holdReasonNote: string | null
  /** Scheduled start/completion date */
  plannedDate: number | null // epoch ms timestamp
  /** Customer collection date */
  pickupDate: number | null // epoch ms timestamp
  /** When payment was completed */
  completedAt: number | null // epoch ms timestamp
  /** Creation timestamp */
  createdAt: number // epoch ms timestamp
}

// ============================================================================
// Repair Line Item — parts used and labor logged
// ============================================================================

/** Type of line item in a repair */
export type RepairLineItemType = 'part' | 'labor'

/** A line item on a repair (parts or labor) */
export interface RepairLineItem {
  /** Unique identifier */
  id: string
  /** Parent repair ID */
  repairId: string
  /** Type of line item */
  lineType: RepairLineItemType
  /** Reference to part catalog (NULL for labor items) */
  partId: string | null
  /** Reference to labor service catalog (NULL for parts) */
  laborServiceId: string | null
  /** Human-readable description */
  description: string
  /** Quantity (default 1) */
  quantity: number
  /** Unit price ex-tax in cents */
  unitPriceNet: number
  /** VAT rate reference ID */
  vatRateId: string
  /** Discount basis points (nullable = no discount) */
  discountPercent: number | null
  /** Net total after discount */
  lineTotalNet: number
  /** VAT amount */
  lineTotalVat: number
  /** Gross total incl. VAT */
  lineTotalGross: number
  /** Billing minutes worked (for hourly labor) */
  minutesWorked: number | null
  /** Worker's rate at time of logging (hourly services) */
  hourlyRateSnapshot: number | null
  /** Creation timestamp */
  createdAt: number // epoch ms timestamp
}

// ============================================================================
// Work Log — timer session per repair
// ============================================================================

/** A manual work timer session for a repair */
export interface WorkLog {
  /** Unique identifier */
  id: string
  /** Parent repair ID */
  repairId: string
  /** Technician who worked (user ID) */
  userId: string
  /** When the timer started */
  startedAt: number // epoch ms timestamp
  /** When the timer stopped (NULL if still running) */
  endedAt: number | null // epoch ms timestamp
  /** Duration in milliseconds (only when endedAt is set) */
  durationMs?: number
}

// ============================================================================
// Status History — audit trail for transitions
// ============================================================================

/** A single status transition record */
export interface RepairStatusHistory {
  /** Unique identifier */
  id: string
  /** Parent repair ID */
  repairId: string
  /** The status this record represents */
  status: RepairStatus
  /** When the transition occurred */
  transitionedAt: number // epoch ms timestamp
}

// ============================================================================
// Intake Input — combined customer + bicycle + notes for new repairs
// ============================================================================

/** Customer lookup result during intake (compact shape) */
export interface IntakeCustomer {
  id: string
  type: 'private' | 'company'
  firstName: string | null
  lastName: string | null
  companyName: string | null
  phone: string | null
  email: string | null
}

/** Bicycle option during intake (compact shape) */
export interface IntakeBicycle {
  id: string
  brand: string
  model: string
  color: string | null
  year: number | null
}

/** Customer selection mode for intake — 'none' for walk-in without customer */
export type CustomerMode = 'existing' | 'new' | 'none'

/** Bicycle selection mode for intake */
export type BicycleMode = 'select_existing' | 'create_new'

/** Input shape for the repair intake form */
export interface RepairIntakeInput {
  /** Whether selecting existing or creating new customer */
  customerMode: CustomerMode
  /** Existing customer ID (when customerMode='existing') */
  existingCustomerId?: string
  /** New customer data (when customerMode='new') */
  newCustomer?: {
    firstName?: string
    lastName?: string
    companyName?: string
    phone: string
    email: string
  }
  /** Whether selecting existing or creating new bicycle */
  bicycleMode: BicycleMode
  /** Existing bicycle ID (when bicycleMode='select_existing') */
  existingBicycleId?: string
  /** New bicycle data (when bicycleMode='create_new') */
  newBicycle?: {
    brand: string
    model: string
    color: string
  }
  /** Customer-facing notes captured at intake */
  customerNotes: string
  /** Scheduled start/completion date (optional, epoch ms) */
  plannedDate?: number | null
  /** Customer collection/pickup date (optional, epoch ms) */
  pickupDate?: number | null
}

// ============================================================================
// Repair Detail — enriched shape with line items and work logs
// ============================================================================

/** A repair detail response including all related data */
export interface RepairDetail {
  /** The repair header */
  repair: Repair
  /** Customer associated with the bicycle */
  customer?: {
    id: string
    firstName: string | null
    lastName: string | null
    companyName: string | null
    phone: string | null
    email: string | null
  }
  /** Bicycle being serviced */
  bicycle: {
    id: string
    brand: string
    model: string
    color: string | null
    year: number | null
  }
  /** Line items (parts and labor) for this repair */
  lineItems: RepairLineItem[]
  /** Work log timer sessions for this repair */
  workLogs: WorkLog[]
}

// ============================================================================
// Labor Service — predefined service catalog entry
// ============================================================================

/** A labor service from the predefined catalog */
export interface LaborService {
  id: string
  name: string
  description: string | null
  billingType: 'hourly' | 'fixed'
  defaultRate: number // cents/hour for hourly, fixed amount for fixed-rate
  isActive: boolean
}

// ============================================================================
// Line Item Input — creating/updating repair line items
// ============================================================================

/** Input for creating a part-based line item */
export interface CreatePartLineItemInput {
  /** Type of line item (always 'part' for this variant) */
  lineType: 'part'
  /** Part ID from the catalog */
  partId: string
  /** Human-readable description (snapshotted at creation) */
  description: string
  /** Quantity of parts used */
  quantity: number
  /** Unit price ex-tax in cents */
  unitPriceNet: number
  /** VAT rate reference ID */
  vatRateId: string
  /** Discount basis points (nullable = no discount) */
  discountPercent?: number | null
}

/** Input for creating a labor-based line item */
export interface CreateLaborLineItemInput {
  /** Type of line item (always 'labor' for this variant) */
  lineType: 'labor'
  /** Labor service ID from the catalog */
  laborServiceId: string
  /** Human-readable description (snapshotted at creation) */
  description: string
  /** Quantity (usually 1 for labor) */
  quantity: number
  /** Unit price ex-tax in cents */
  unitPriceNet: number
  /** VAT rate reference ID */
  vatRateId: string
  /** Discount basis points (nullable = no discount) */
  discountPercent?: number | null
  /** Minutes worked for billing purposes */
  minutesWorked?: number | null
  /** Worker's hourly rate snapshot at time of logging */
  hourlyRateSnapshot?: number | null
}

/** Union type for creating any line item on a repair */
export type CreateRepairLineItemInput = CreatePartLineItemInput | CreateLaborLineItemInput

/** Input for updating an existing repair line item */
export interface UpdateRepairLineItemInput {
  /** Quantity (for parts) */
  quantity?: number
  /** Unit price ex-tax in cents */
  unitPriceNet?: number
  /** Discount basis points */
  discountPercent?: number | null
  /** Minutes worked (for labor items) */
  minutesWorked?: number | null
  /** Hourly rate snapshot (for hourly labor items) */
  hourlyRateSnapshot?: number | null
}

// ============================================================================
// Worker Assignment — reassigning a repair to a different technician
// ============================================================================

/** Input for assigning or changing the assigned worker on a repair */
export interface AssignWorkerInput {
  /** Worker ID to assign (nullable to unassign) */
  assignedTo: string | null
}

// ============================================================================
// Payment Completion — atomic transaction at repair completion
// ============================================================================

/** A single payment method entry for split payments */
export interface RepairPaymentMethod {
  /** Payment method */
  method: 'cash' | 'card'
  /** Amount in cents to charge via this method */
  amount: number
}

/** Input for completing a repair with payment data (single or split) */
export interface CompleteRepairInput {
  /** Array of payment methods — single entry for single-payment, multiple for split */
  payments: RepairPaymentMethod[]
}

/** Result returned after successful repair completion */
export interface CompleteRepairResult {
  /** The updated repair record with completedAt set */
  repair: {
    id: string
    bicycleId: string
    assignedTo: string | null
    status: RepairStatus
    customerNotes: string | null
    internalNotes: string | null
    holdReason: HoldReason | null
    holdReasonNote: string | null
    plannedDate: number | null
    pickupDate: number | null
    completedAt: number | null
    createdAt: number
  }
  /** The linked sale record created for revenue attribution */
  sale: {
    id: string
    saleNumber: string
    customerId: string | null
    sourceType: 'direct_sale' | 'repair' | 'customer_order' | 'backorder'
    sourceId: string | null
    status: 'completed' | 'voided'
    subtotalNet: number
    vatTotal: number
    totalGross: number
  }
  /** All payments created for this completion */
  payments: Array<{
    id: string
    method: 'cash' | 'card' | 'bank_transfer'
    amount: number
  }>
  /** Stock movements created for parts used */
  stockMovements: Array<{
    id: string
    partId: string
    quantityDelta: number
    reason: string
    referenceType: string
    referenceId: string
  }>
}
