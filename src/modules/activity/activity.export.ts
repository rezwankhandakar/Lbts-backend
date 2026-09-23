import type { Column, Worksheet } from 'exceljs'
import { describeChange } from './activity.diff'
import type { ActivityRecord } from './activity.serializer'

/**
 * The journal as a real spreadsheet.
 *
 * An `.xlsx` rather than a CSV, for the reason every other export in this
 * codebase gives: a journal row carries a timestamp, and a CSV hands that to
 * Excel as text to be re-guessed against the machine's locale.
 *
 * **One row per event, and the changes flattened into one cell.** That is the
 * opposite of the choice the gate pass export makes — where a product line
 * gets its own row so the sheet can be pivoted — and the reason is that a
 * change is not a unit anybody counts. Somebody exporting the journal is
 * counting *events*, and splitting a five-field correction into five rows
 * would make "how many corrections did we make in August" answer five times
 * too high in a sheet nothing warned them about.
 */

const COLUMNS: Partial<Column>[] = [
  { header: 'When', key: 'when', width: 20, style: { numFmt: 'dd-mmm-yyyy hh:mm' } },
  { header: 'Module', key: 'module', width: 16 },
  { header: 'Action', key: 'actionLabel', width: 24 },
  { header: 'Severity', key: 'severity', width: 11 },
  { header: 'Category', key: 'category', width: 12 },
  { header: 'What happened', key: 'summary', width: 56 },
  { header: 'Record', key: 'entityLabel', width: 28 },
  { header: 'Record type', key: 'entityType', width: 14 },
  { header: 'By', key: 'actor', width: 22 },
  { header: 'Role', key: 'actorRole', width: 11 },
  { header: 'Changes', key: 'changes', width: 60 },
  { header: 'Action id', key: 'action', width: 22 },
  { header: 'Record id', key: 'entityId', width: 26 },
]

const SEVERITY_FILL: Record<string, string> = {
  critical: 'FFFDE8E8',
  notice: 'FFFDF4E3',
}

/**
 * A timestamp written at **local** time.
 *
 * Excel stores an instant as a serial number that ExcelJS derives using the
 * machine's own offset, so handing it a UTC date would show every event an
 * hour or six earlier than the page did. The same correction
 * `gate-pass.export.ts` makes for a trip date, for the same reason.
 */
function toSheetInstant(iso: string): Date | null {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) {
    return null
  }
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
  )
}

function styleHeader(sheet: Worksheet): void {
  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDF2' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFCC' } } }
  })
  header.height = 20
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
}

export async function buildActivityWorkbook(rows: ActivityRecord[]): Promise<Uint8Array> {
  // Loaded on demand: it is the largest dependency in the process and no other
  // request path in this module touches it. CommonJS, so it comes off `default`.
  const { default: ExcelJS } = await import('exceljs')

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'LBTS'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Activity')
  sheet.columns = COLUMNS

  for (const row of rows) {
    const added = sheet.addRow({
      when: toSheetInstant(row.createdAt),
      module: row.module,
      actionLabel: row.actionLabel,
      severity: row.severity,
      category: row.category,
      summary: row.summary,
      entityLabel: row.entityLabel,
      entityType: row.entityType,
      actor: row.actor?.name ?? '',
      actorRole: row.actor?.role ?? '',
      changes: row.changes.map(describeChange).join(' · '),
      action: row.action,
      entityId: row.entityId ?? '',
    })

    /**
     * A tint on the rows that matter, because the point of taking a journal
     * off the system is usually to go looking for the dangerous ones, and
     * thirteen columns of grey is not where you find them.
     */
    const fill = SEVERITY_FILL[row.severity]
    if (fill) {
      added.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
      })
    }
  }

  sheet.getColumn('summary').alignment = { wrapText: true, vertical: 'top' }
  sheet.getColumn('changes').alignment = { wrapText: true, vertical: 'top' }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } }
  styleHeader(sheet)

  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer)
}

export function activityExportFilename(): string {
  return `lbts-activity-${new Date().toISOString().slice(0, 10)}.xlsx`
}
