export const UNITS = {
  hours: 'Hours',
  days: 'Days',
  person_hours: 'Person-hours',
  person_days: 'Person-days',
  items: 'Items',
  seats: 'Seats',
  square_metres: 'Square metres',
} as const;
export type Unit = keyof typeof UNITS;

export const LINE_STATUSES = {
  needed: 'Needed',
  arranged: 'Arranged',
  in_use: 'In use',
  finished: 'Finished',
  cancelled: 'Cancelled',
} as const;
export type LineStatus = keyof typeof LINE_STATUSES;

export const ONE_OFF_KINDS = ['equipment', 'facility', 'other'] as const;
/** Display words for item and one-off kinds (the Resources tab and the report CSV). */
export const KIND_LABELS: Record<(typeof ONE_OFF_KINDS)[number], string> = { equipment: 'Equipment', facility: 'Facility', other: 'Other' };
export const ITEM_KINDS = ['equipment', 'facility'] as const;
