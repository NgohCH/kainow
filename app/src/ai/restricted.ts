/**
 * Restricted material (spec 3, 6.3): text from a source or a thread whose audience is in mode `restricted`. Only a
 * connection whose model is approved for restricted material may receive it (D86).
 *
 * Each runner works this out in the same statement that reads the text it sends, at every attempt, because an audience
 * can change while a request waits. When in doubt it is restricted: wrongly refusing a connection only costs a blocked
 * request, while wrongly allowing one breaks D86. So a missing audience row counts as restricted.
 */

/** SQL: the thread `threadExpr` (a uuid expression; NULL for none) has a Restricted audience. */
export function threadRestrictedSql(threadExpr: string): string {
  return `EXISTS (SELECT 1 FROM discussion_threads rth JOIN audiences rta ON rta.id = rth.audience_id
                   WHERE rth.id = ${threadExpr} AND rta.mode = 'restricted')`;
}

/**
 * SQL: the source row `s` carries restricted material: its audience is Restricted (or missing), it was submitted to be
 * Restricted (intended_mode), or the thread, discussion or meeting it belongs to has a Restricted audience.
 */
export function sourceRestrictedSql(s: string): string {
  return `(COALESCE((SELECT ra.mode FROM audiences ra WHERE ra.id = ${s}.audience_id), 'restricted') = 'restricted'
           OR ${s}.intended_mode IS NOT DISTINCT FROM 'restricted'
           OR ${threadRestrictedSql(`${s}.thread_id`)})`;
}

/**
 * SQL: one row `m` of ai_request_material, with its passage joined as `p` (LEFT JOIN), is restricted material. A passage
 * belongs to a source version or to a message version; a record snapshot carries its audience (none for Project-wide
 * records), and an AI proposal is also as restricted as the source it was extracted from.
 */
export function materialRestrictedSql(m: string, p: string): string {
  return `(CASE
     WHEN ${m}.passage_id IS NOT NULL THEN
       CASE ${p}.owner_kind
         WHEN 'source_version' THEN COALESCE((SELECT ${sourceRestrictedSql('rs')} FROM source_versions rv JOIN sources rs ON rs.id = rv.source_id WHERE rv.id = ${p}.owner_id), true)
         WHEN 'message_version' THEN COALESCE((SELECT ${threadRestrictedSql('rdm.thread_id')} FROM message_versions rmv JOIN discussion_messages rdm ON rdm.id = rmv.message_id WHERE rmv.id = ${p}.owner_id), true)
         ELSE true
       END
     ELSE
       (${m}.record_audience_id IS NOT NULL AND COALESCE((SELECT ra.mode FROM audiences ra WHERE ra.id = ${m}.record_audience_id), 'restricted') = 'restricted')
       OR (${m}.record_kind = 'ai_proposal'
           AND COALESCE((SELECT ${sourceRestrictedSql('rs')} FROM extraction_items rx JOIN source_versions rv ON rv.id = rx.source_version_id JOIN sources rs ON rs.id = rv.source_id
                          WHERE rx.id = ${m}.record_id), true))
   END)`;
}
