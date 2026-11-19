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
export const ITEM_KINDS = ['equipment', 'facility'] as const;
