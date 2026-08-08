import type { Node as ProseMirrorNode } from "prosemirror-model";
import { EditorView } from "prosemirror-view";

import {
  ClauseView,
  ParameterSlot,
  literalInput,
  option,
  removeButton,
  selectControl,
} from "./editor-controls";
import type { EditableStatisticCondition } from "./editor";
import {
  explorerMetricName,
  type ExplorerAggregate,
  type ExplorerAggregateMetric,
} from "./explorer";
import type { Owner } from "./contract";
import {
  AGGREGATE_FUNCTION_LABEL,
  FIELD_LABEL,
  OPERATOR_LABEL,
  describeAggregateMetric,
  queryAggregateFields,
  queryConditionOperators,
  queryGroupFields,
  queryStatisticColumns,
} from "./workbench-model";

export class AggregateView extends ClauseView {
  private readonly groupSummary = document.createElement("summary");
  private readonly groupList = document.createElement("span");
  private readonly metricSummary = document.createElement("summary");
  private readonly metricList = document.createElement("div");
  private readonly havingSummary = document.createElement("summary");
  private readonly havingList = document.createElement("div");
  private renderSignature = "";

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    private readonly owner: Owner,
  ) {
    super("aggregate", node, view, getPos);
    const groups = document.createElement("details");
    groups.className = "query-slot-menu";
    this.groupSummary.className = "query-slot";
    groups.append(this.groupSummary, this.groupList);

    const metrics = document.createElement("details");
    metrics.className = "query-aggregate-menu";
    this.metricSummary.className = "query-slot";
    metrics.append(this.metricSummary, this.metricList);

    const having = document.createElement("details");
    having.className = "query-aggregate-menu";
    this.havingSummary.className = "query-slot";
    having.append(this.havingSummary, this.havingList);

    this.dom.append(
      document.createTextNode("统计"),
      groups,
      metrics,
      having,
      removeButton(() => this.remove(), "移除统计"),
    );
    this.render();
  }

  private groupBy(): string[] {
    return Array.isArray(this.node.attrs.groupBy)
      ? (this.node.attrs.groupBy as string[])
      : [];
  }

  private metrics(): ExplorerAggregateMetric[] {
    return Array.isArray(this.node.attrs.metrics)
      ? (this.node.attrs.metrics as ExplorerAggregateMetric[])
      : [];
  }

  private having(): EditableStatisticCondition[] {
    return Array.isArray(this.node.attrs.having)
      ? (this.node.attrs.having as EditableStatisticCondition[])
      : [];
  }

  private aggregate(): ExplorerAggregate {
    return { groupBy: this.groupBy(), metrics: this.metrics() };
  }

  private setMetrics(metrics: ExplorerAggregateMetric[]): void {
    this.updateAttrs({ metrics });
  }

  private setHaving(
    having: EditableStatisticCondition[],
    preserveControls = false,
  ): void {
    if (preserveControls) {
      this.renderSignature = JSON.stringify({
        groups: this.groupBy(),
        metrics: this.metrics(),
        having,
      });
    }
    this.updateAttrs({ having });
  }

  private render(): void {
    const groupBy = this.groupBy();
    const metrics = this.metrics();
    const having = this.having();
    const signature = JSON.stringify({ groups: groupBy, metrics, having });
    if (signature === this.renderSignature) return;
    this.renderSignature = signature;
    this.renderGroups(groupBy);
    this.renderMetrics(metrics);
    this.renderHaving(having);
  }

  private renderGroups(selected: string[]): void {
    const fields = queryGroupFields(this.owner);
    const items = fields.map((field) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "统计分组";
      input.value = field;
      input.checked = selected.includes(field);
      input.addEventListener("change", () => {
        const groupBy = [...this.groupList.querySelectorAll<HTMLInputElement>("input:checked")]
          .map((item) => item.value);
        this.updateAttrs({ groupBy });
      });
      label.append(input, document.createTextNode(FIELD_LABEL[field] ?? field));
      return label;
    });
    this.groupList.replaceChildren(...items);
    this.groupSummary.textContent = selected.length
      ? `按${selected.map((field) => FIELD_LABEL[field] ?? field).join("、")}分组`
      : "不分组";
  }

  private renderMetrics(metrics: ExplorerAggregateMetric[]): void {
    const fields = queryAggregateFields(this.owner);
    const rows = metrics.map((metric, index) => {
      const row = document.createElement("div");
      row.className = "query-aggregate-row";
      const fn = selectControl("统计方式");
      for (const [value, label] of Object.entries(AGGREGATE_FUNCTION_LABEL))
        fn.append(option(value, label));
      fn.value = metric.function;
      const field = selectControl("统计字段");
      if (fn.value === "count") field.append(option("", "所有条目"));
      for (const name of fields)
        field.append(option(name, FIELD_LABEL[name] ?? name));
      field.value = metric.field ?? "";
      if (!field.value && fn.value !== "count") field.selectedIndex = 0;
      fn.addEventListener("change", () => {
        const nextFunction = fn.value as ExplorerAggregateMetric["function"];
        const nextField = nextFunction === "count"
          ? undefined
          : field.value || fields[0];
        this.setMetrics(metrics.map((item, current) =>
          current === index
            ? { function: nextFunction, ...(nextField ? { field: nextField } : {}) }
            : item
        ));
      });
      field.addEventListener("change", () =>
        this.setMetrics(metrics.map((item, current) =>
          current === index
            ? { ...item, ...(field.value ? { field: field.value } : { field: undefined }) }
            : item
        ))
      );
      row.append(
        fn,
        field,
        removeButton(
          () => this.setMetrics(metrics.filter((_, current) => current !== index)),
          "移除统计指标",
        ),
      );
      return row;
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "query-aggregate-add";
    add.textContent = "＋ 指标";
    add.addEventListener("click", () =>
      this.setMetrics([...metrics, { function: "count" }])
    );
    this.metricList.replaceChildren(...rows, add);
    this.metricSummary.textContent = metrics.length
      ? metrics.map(describeAggregateMetric).join("、")
      : "选择统计指标";
  }

  private renderHaving(having: EditableStatisticCondition[]): void {
    const aggregate = this.aggregate();
    const outputs = queryStatisticColumns(aggregate);
    const metricOutputs = new Set(aggregate.metrics.map(explorerMetricName));
    const rows = having.map((condition, index) => {
      const row = document.createElement("div");
      row.className = "query-aggregate-row";
      const field = selectControl("统计结果");
      for (const output of outputs) field.append(option(output.value, output.label));
      field.value = condition.field;
      if (!field.value) field.selectedIndex = 0;
      const operator = selectControl("统计结果比较方式");
      const operatorNames = metricOutputs.has(field.value)
        ? ["eq", "ne", "lt", "lte", "gt", "gte", "in", "notIn", "isNull", "isNotNull"]
        : queryConditionOperators(this.owner, field.value);
      for (const name of operatorNames)
        operator.append(option(name, OPERATOR_LABEL[name] ?? name));
      operator.value = condition.operator;
      if (!operator.value) operator.selectedIndex = 0;
      const value = literalInput("统计结果条件的值");
      value.value = condition.raw;
      value.type = metricOutputs.has(field.value) ? "number" : "text";
      value.hidden = ["isNull", "isNotNull", "isMissing", "isPresent"].includes(operator.value);
      const parameter = new ParameterSlot(
        condition.parameter ?? "",
        () => `${field.value || "result"}Value${index + 1}`,
        (name) => this.setHaving(having.map((item, current) =>
          current === index ? { ...item, parameter: name } : item
        )),
      );
      parameter.setAvailable(![
        "in", "notIn", "isNull", "isNotNull", "isMissing", "isPresent",
      ].includes(operator.value));
      field.addEventListener("change", () => {
        const numeric = metricOutputs.has(field.value);
        const nextOperator = numeric
          ? "eq"
          : queryConditionOperators(this.owner, field.value)[0] ?? "";
        this.setHaving(having.map((item, current) =>
          current === index
            ? { field: field.value, operator: nextOperator, raw: "", parameter: "" }
            : item
        ));
      });
      operator.addEventListener("change", () =>
        this.setHaving(having.map((item, current) =>
          current === index
            ? { ...item, operator: operator.value, raw: "", parameter: "" }
            : item
        ))
      );
      value.addEventListener("input", () => {
        const next = having.map((item, current) =>
          current === index ? { ...item, raw: value.value } : item
        );
        this.setHaving(next, true);
      });
      row.append(
        field,
        operator,
        parameter.dom,
        value,
        removeButton(
          () => this.setHaving(having.filter((_, current) => current !== index)),
          "移除统计结果条件",
        ),
      );
      return row;
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "query-aggregate-add";
    add.textContent = "＋ 结果条件";
    add.disabled = outputs.length === 0;
    add.addEventListener("click", () => {
      const output = outputs.find((item) => metricOutputs.has(item.value)) ?? outputs[0];
      if (!output) return;
      this.setHaving([...having, {
        field: output.value,
        operator: metricOutputs.has(output.value)
          ? "gte"
          : queryConditionOperators(this.owner, output.value)[0] ?? "",
        raw: "",
        parameter: "",
      }]);
    });
    this.havingList.replaceChildren(...rows, add);
    this.havingSummary.textContent = having.length
      ? `结果条件（${having.length}）`
      : "结果条件";
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.render();
    return true;
  }
}
