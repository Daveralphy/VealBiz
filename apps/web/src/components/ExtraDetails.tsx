import { Card } from "@windveal/ui";

type Props = { reference?: string | null; referenceLabel: string; extra?: Record<string, string> | null };

function rows({ reference, referenceLabel, extra }: Props): [string, string][] {
  return [...(reference ? [[referenceLabel, reference] as [string, string]] : []), ...Object.entries(extra ?? {})];
}

/** The record's own ID and any other columns kept from an imported spreadsheet, as a list. */
export function ExtraDetailsList(props: Props) {
  const items = rows(props);
  if (!items.length) return null;
  return (
    <dl className="kv">
      {items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

/** Same as ExtraDetailsList, in a card. Shows nothing when there's nothing to show. */
export function ExtraDetailsCard(props: Props & { title?: string }) {
  if (!rows(props).length) return null;
  return <Card title={props.title ?? "Other details"} subtitle="From your imported spreadsheet."><ExtraDetailsList {...props} /></Card>;
}
