const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const QUERY_ICON_PATHS = {
  back: ["M19 12H5", "M12 5l-7 7 7 7"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  collapse: ["M6 15l6-6 6 6"],
  expand: ["M6 9l6 6 6-6"],
  plus: ["M12 5v14", "M5 12h14"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m16 16 4 4"],
  stop: ["M8 8h8v8H8z"],
} as const;

export type QueryIconName = keyof typeof QUERY_ICON_PATHS;

export function createQueryIcon(name: QueryIconName): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.setAttribute("class", "query-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  for (const data of QUERY_ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", data);
    icon.append(path);
  }
  return icon;
}

export function setQueryIconButton(
  button: HTMLButtonElement,
  icon: QueryIconName,
  label: string,
  title = label,
): void {
  button.replaceChildren(createQueryIcon(icon));
  button.dataset.queryIcon = icon;
  button.setAttribute("aria-label", label);
  button.title = title;
}
