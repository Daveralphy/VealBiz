import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Input, Notice, Select, Textarea, useToast } from "@windveal/ui";
import { api } from "../../lib/api";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import { toDateInput } from "../../lib/format";
import { EMPLOYMENT_TYPES, localYmd, peopleKeys, useDepartments, useEmployeeOptions, type Profile } from "./lib";

type Values = {
  firstName: string; lastName: string; email: string; phone: string; jobTitle: string; departmentId: string; managerId: string;
  startDate: string; employmentType: string; location: string; employeeCode: string; dateOfBirth: string; homeAddress: string;
  emergencyContact: string; nationalId: string; startOnboarding: boolean; invite: boolean;
};

function initialValues(e?: Profile | null): Values {
  return {
    firstName: e?.firstName ?? "", lastName: e?.lastName ?? "", email: e?.email ?? "", phone: e?.phone ?? "", jobTitle: e?.jobTitle ?? "",
    departmentId: e?.departmentId ?? "", managerId: e?.managerId ?? "", startDate: toDateInput(e?.startDate) || (e ? "" : localYmd()),
    employmentType: e?.employmentType ?? (e ? "" : "Full-time"), location: e?.location ?? "", employeeCode: e?.employeeCode ?? "",
    dateOfBirth: toDateInput(e?.personal?.dateOfBirth), homeAddress: e?.personal?.homeAddress ?? "", emergencyContact: e?.personal?.emergencyContact ?? "",
    nationalId: e?.personal?.nationalId ?? "", startOnboarding: true, invite: false,
  };
}

/** Add employee (no `employee`) or edit an existing one. */
export function EmployeeDrawer({ open, onClose, onSaved, employee }: {
  open: boolean; onClose: () => void; onSaved?: (id: string) => void; employee?: Profile | null;
}) {
  const editing = !!employee;
  const { isAdmin } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const f = useForm<Values>(initialValues(employee));
  const depts = useDepartments();
  const options = useEmployeeOptions(open);
  const locs = useQuery({
    queryKey: ["people", "locations"], enabled: open,
    queryFn: () => api.get<{ locations: string[] }>("/api/people/employees?pageSize=1&status=all").then((r) => r.locations),
  });

  useEffect(() => {
    if (open) { f.setValues(initialValues(employee)); f.setErrors({}); f.setFormError(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee?.id]);

  const managers = useMemo(() => (options.data ?? []).filter((o) => o.id !== employee?.id), [options.data, employee?.id]);
  const first = f.values.firstName.trim() || "this person";

  const save = () => f.submit(async (v) => {
    const body: Record<string, unknown> = {
      firstName: v.firstName, lastName: v.lastName, email: v.email, phone: v.phone, jobTitle: v.jobTitle, departmentId: v.departmentId,
      managerId: v.managerId, startDate: v.startDate, employmentType: v.employmentType, location: v.location,
    };
    if (editing) {
      Object.assign(body, { employeeCode: v.employeeCode, dateOfBirth: v.dateOfBirth, homeAddress: v.homeAddress, emergencyContact: v.emergencyContact });
      // The ID is shown masked to people who can't edit; only send it when it was actually changed.
      if (v.nationalId !== (employee?.personal?.nationalId ?? "")) body.nationalId = v.nationalId;
      await api.patch(`/api/people/employees/${employee!.id}`, body);
      toast(`${v.firstName}'s details were saved`);
    } else {
      body.startOnboarding = v.startOnboarding;
      const r = await api.post<{ employee: { id: string; name: string }; notice: string | null }>("/api/people/employees", body);
      let msg = `${r.employee.name} was added`;
      if (v.invite && v.email) {
        try {
          const inv = await api.post<{ results: { status: string }[] }>("/api/invitations", { invites: [{ email: v.email, role: "member" }] });
          const st = inv.results[0]?.status;
          msg += st === "sent" ? " and invited to WindVeal" : st === "already_member" ? " (they already use WindVeal)" : " (an invitation is already pending)";
        } catch {
          msg += ", but the invitation couldn't be sent";
        }
      }
      toast(r.notice ? `${msg}. ${r.notice}` : msg);
      onSaved?.(r.employee.id);
    }
    await qc.invalidateQueries({ queryKey: peopleKeys.all });
    if (editing) { onSaved?.(employee!.id); onClose(); }
  });

  return (
    <Drawer open={open} onClose={onClose} title={editing ? `Edit ${employee!.firstName}` : "Add employee"}
      footer={<>
        {!editing ? <span className="muted ppl-foot-note">Add pay details later</span> : <span />}
        <div className="row">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={f.busy} onClick={save}>{editing ? "Save changes" : "Add employee"}</Button>
        </div>
      </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="section-label">Basic details</div>
        <div className="form-grid">
          <Input label="First name" autoFocus {...f.bind("firstName")} />
          <Input label="Last name" {...f.bind("lastName")} />
          <Input label="Work email" type="email" optional {...f.bind("email")} />
          <Input label="Phone" optional type="tel" placeholder="+234" {...f.bind("phone")} />
        </div>
        <div className="section-label">Job</div>
        <div className="form-grid">
          <Input label="Job title" {...f.bind("jobTitle")} />
          <Select label="Department" {...f.bind("departmentId")} placeholder="No department"
            options={(depts.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
          <Select label="Manager" {...f.bind("managerId")} placeholder="No manager"
            options={managers.map((m) => ({ value: m.id, label: m.name }))} />
          <Input label="Start date" type="date" {...f.bind("startDate")} />
          <Select label="Employment type" {...f.bind("employmentType")} placeholder="Choose" options={EMPLOYMENT_TYPES} />
          <Input label="Location" list="ppl-locations" placeholder="e.g. Lagos office" {...f.bind("location")} />
          <datalist id="ppl-locations">{(locs.data ?? []).map((l) => <option key={l} value={l} />)}</datalist>
        </div>
        {editing ? (
          <>
            <div className="section-label">Personal</div>
            <div className="form-grid">
              <Input label="Employee ID" optional {...f.bind("employeeCode")} />
              <Input label="Date of birth" optional type="date" {...f.bind("dateOfBirth")} />
              <Input label="Emergency contact" optional placeholder="Name · phone" {...f.bind("emergencyContact")} />
              <Input label="National ID" optional {...f.bind("nationalId")} />
              <Textarea label="Home address" optional wrapClassName="span-2" rows={2} {...f.bind("homeAddress")} />
            </div>
          </>
        ) : (
          <>
            <label className="ppl-choice">
              <input type="checkbox" checked={f.values.startOnboarding} onChange={(e) => f.set("startOnboarding", e.target.checked)} />
              <span><b>Start the onboarding checklist</b><small>Creates onboarding tasks in Workflows for {first}'s manager and HR.</small></span>
            </label>
            {isAdmin && (
              <label className="ppl-choice soft">
                <input type="checkbox" checked={f.values.invite} onChange={(e) => f.set("invite", e.target.checked)} />
                <span>
                  <b>Invite {first} to WindVeal</b>
                  <small>{f.values.invite && !f.values.email ? "Add a work email to send the invitation." : `Only if ${first} needs to use the app.`}</small>
                </span>
              </label>
            )}
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
