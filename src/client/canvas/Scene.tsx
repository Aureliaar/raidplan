import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Arrow,
  Circle,
  Ellipse,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  RegularPolygon,
  Ring,
  Stage,
  Text,
  Wedge,
} from "react-konva";
import type Konva from "konva";
import type { Entity, Plan, ZoneEntity } from "../../shared/schema";
import { entitiesForStep } from "../../shared/schema";
import { jobColor, jobLabel } from "../../shared/jobs";
import { assetUrl, enemyIconKey, jobIconKey, waymarkIconKey } from "../../shared/assets";

/**
 * Top-down arena renderer. Everything is drawn in arena units inside one scaled
 * group, so the plan JSON never has to know about pixels.
 */

const ZONE_DEFAULT = "#ff7043";
const MARKER_COLORS: Record<string, string> = {
  A: "#e05252",
  B: "#e0c452",
  C: "#5aa8e0",
  D: "#b06ce0",
  "1": "#e05252",
  "2": "#e0c452",
  "3": "#5aa8e0",
  "4": "#b06ce0",
};

export interface SceneProps {
  plan: Plan;
  stepId?: string;
  size: number;
  selected: string | null;
  editable: boolean;
  onSelect(id: string | null): void;
  onMove(id: string, x: number, y: number): void;
}

export function Scene({ plan, stepId, size, selected, editable, onSelect, onMove }: SceneProps) {
  const { arena } = plan;
  const scale = size / Math.max(arena.width, arena.height);
  const entities = useMemo(() => entitiesForStep(plan, stepId), [plan, stepId]);
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);

  return (
    <Stage
      width={size}
      height={size}
      onMouseDown={(e) => {
        if (e.target === e.target.getStage()) onSelect(null);
      }}
    >
      <Layer>
        <Group x={size / 2} y={size / 2} scaleX={scale} scaleY={scale}>
          <ArenaFloor plan={plan} />
          {entities.map((e) =>
            e.type === "tether" ? (
              <Tether key={e.id} entity={e} byId={byId} selected={selected === e.id} onSelect={onSelect} />
            ) : (
              <Group
                key={e.id}
                x={e.x}
                y={e.y}
                rotation={e.rotation}
                scaleX={e.scale}
                scaleY={e.scale}
                opacity={e.opacity}
                draggable={editable && !e.locked}
                onMouseDown={() => onSelect(e.id)}
                onTap={() => onSelect(e.id)}
                onDragEnd={(ev) => onMove(e.id, Math.round(ev.target.x()), Math.round(ev.target.y()))}
              >
                <EntityShape entity={e} />
                {selected === e.id && <SelectionRing entity={e} />}
              </Group>
            )
          )}
        </Group>
      </Layer>
    </Stage>
  );
}

function ArenaFloor({ plan }: { plan: Plan }) {
  const { arena } = plan;
  const w = arena.width;
  const h = arena.shape === "rect" ? arena.height : arena.width;
  const lines: React.ReactNode[] = [];
  const g = arena.grid;

  if (g.type === "square") {
    for (let i = 1; i < g.cols; i++) {
      const x = -w / 2 + (w / g.cols) * i;
      lines.push(<Line key={`v${i}`} points={[x, -h / 2, x, h / 2]} stroke={g.color} strokeWidth={2} />);
    }
    for (let i = 1; i < g.rows; i++) {
      const y = -h / 2 + (h / g.rows) * i;
      lines.push(<Line key={`h${i}`} points={[-w / 2, y, w / 2, y]} stroke={g.color} strokeWidth={2} />);
    }
  } else if (g.type === "radial") {
    for (let i = 1; i <= g.rings; i++)
      lines.push(
        <Circle key={`r${i}`} radius={(w / 2) * (i / g.rings)} stroke={g.color} strokeWidth={2} />
      );
    for (let i = 0; i < g.spokes; i++) {
      const a = ((i / g.spokes) * 360 + g.angle - 90) * (Math.PI / 180);
      lines.push(
        <Line
          key={`s${i}`}
          points={[0, 0, Math.cos(a) * (w / 2), Math.sin(a) * (w / 2)]}
          stroke={g.color}
          strokeWidth={2}
        />
      );
    }
  } else if (g.type === "cross") {
    lines.push(<Line key="cx" points={[-w / 2, 0, w / 2, 0]} stroke={g.color} strokeWidth={2} />);
    lines.push(<Line key="cy" points={[0, -h / 2, 0, h / 2]} stroke={g.color} strokeWidth={2} />);
  }

  const backdrop = assetUrl(arena.image);

  const floor =
    arena.shape === "circle" ? (
      <Circle radius={w / 2} fill={arena.color} stroke={arena.border} strokeWidth={4} />
    ) : (
      <Rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        fill={arena.color}
        stroke={arena.border}
        strokeWidth={4}
        cornerRadius={8}
      />
    );

  const clip =
    arena.shape === "circle"
      ? (ctx: Konva.Context) => {
          ctx.arc(0, 0, w / 2, 0, Math.PI * 2, false);
        }
      : undefined;

  return (
    <Group listening={false}>
      {floor}
      <Group clipFunc={clip}>
        {backdrop && (
          <Sprite src={backdrop} width={w} height={h} opacity={arena.imageOpacity} />
        )}
        {lines}
      </Group>
    </Group>
  );
}

function SelectionRing({ entity }: { entity: Entity }) {
  const r = radiusHint(entity) + 14;
  return <Circle radius={r} stroke="#7aa2f7" strokeWidth={4} dash={[12, 8]} listening={false} />;
}

function radiusHint(e: Entity): number {
  switch (e.type) {
    case "player":
    case "marker":
      return e.size / 2;
    case "enemy":
      return e.size;
    case "zone":
      return e.shape === "rect" || e.shape === "line" || e.shape === "knockback" || e.shape === "arrow"
        ? Math.max(e.width, e.length) / 2
        : e.radius;
    case "text":
      return e.fontSize;
    default:
      return 40;
  }
}

function EntityShape({ entity }: { entity: Entity }) {
  switch (entity.type) {
    case "marker": {
      const color = entity.color ?? MARKER_COLORS[entity.marker];
      const r = entity.size / 2;
      return (
        <Sprite
          src={assetUrl(waymarkIconKey(entity.marker))}
          width={entity.size}
          height={entity.size}
          fallback={
            <>
              <Circle radius={r} fill={color} opacity={0.35} stroke={color} strokeWidth={4} />
              <Label text={entity.marker} size={entity.size * 0.7} color={color} />
            </>
          }
        />
      );
    }

    case "player": {
      const color = entity.color ?? jobColor(entity.job);
      const r = entity.size / 2;
      const icon = assetUrl(entity.icon ?? jobIconKey(entity.job, entity.name));
      return (
        <>
          <Sprite
            src={icon}
            width={entity.size}
            height={entity.size}
            fallback={
              <>
                <Circle radius={r} fill={color} stroke="#0d1117" strokeWidth={3} />
                <Label text={jobLabel(entity.job)} size={entity.size * 0.38} color="#0d1117" bold />
              </>
            }
          />
          {/* Role-coloured frame: the job art alone does not read as tank/healer/dps. */}
          <Rect
            x={-r}
            y={-r}
            width={entity.size}
            height={entity.size}
            stroke={color}
            strokeWidth={6}
            cornerRadius={8}
            listening={false}
          />
          {entity.name && (
            <Text
              text={entity.name}
              y={r + 4}
              width={200}
              offsetX={100}
              align="center"
              fontSize={entity.size * 0.36}
              fill="#e6edf3"
              stroke="#0d1117"
              strokeWidth={4}
              fillAfterStrokeEnabled
            />
          )}
          {entity.showFacing && (
            <Line points={[0, -r, 0, -r - 18]} stroke="#e6edf3" strokeWidth={6} lineCap="round" />
          )}
        </>
      );
    }

    case "enemy": {
      const color = entity.color ?? "#c0392b";
      return (
        <>
          {entity.ring && <Circle radius={entity.size} stroke={color} strokeWidth={3} dash={[14, 10]} opacity={0.7} />}
          {/* The enemy art is a square tile; clip it to the hitbox circle. */}
          <Group
            clipFunc={(ctx: Konva.Context) => {
              ctx.arc(0, 0, entity.size * 0.55, 0, Math.PI * 2, false);
            }}
          >
            <Sprite
              src={assetUrl(entity.icon ?? enemyIconKey(entity.size))}
              width={entity.size * 1.15}
              height={entity.size * 1.15}
              fallback={<Circle radius={entity.size * 0.55} fill={color} />}
            />
          </Group>
          <Circle radius={entity.size * 0.55} stroke="#0d1117" strokeWidth={5} listening={false} />
          {entity.showFacing && (
            <Line
              points={[0, -entity.size * 0.55, 0, -entity.size * 0.55 - 24]}
              stroke="#e6edf3"
              strokeWidth={8}
              lineCap="round"
            />
          )}
          {entity.name && (
            <Text
              text={entity.name}
              y={entity.size * (entity.ring ? 1.05 : 0.62)}
              width={400}
              offsetX={200}
              align="center"
              fontSize={38}
              fill="#e6edf3"
              stroke="#0d1117"
              strokeWidth={5}
              fillAfterStrokeEnabled
            />
          )}
        </>
      );
    }

    case "zone":
      return <ZoneShape zone={entity} />;

    case "text":
      return (
        <Text
          text={entity.text}
          fontSize={entity.fontSize}
          width={1200}
          offsetX={600}
          offsetY={entity.fontSize / 2}
          align={entity.align}
          fill={entity.color ?? "#e6edf3"}
          stroke={entity.outline ? "#0d1117" : undefined}
          strokeWidth={entity.outline ? 6 : 0}
          fillAfterStrokeEnabled
        />
      );

    case "path":
      return (
        <Line
          points={entity.points}
          stroke={entity.color ?? "#e6edf3"}
          strokeWidth={entity.width}
          closed={entity.closed}
          dash={entity.dashed ? [20, 14] : undefined}
          lineCap="round"
          lineJoin="round"
        />
      );

    case "icon":
      return <Sprite src={assetUrl(entity.src)} width={entity.size} height={entity.size} />;

    default:
      return null;
  }
}

function ZoneShape({ zone }: { zone: ZoneEntity }) {
  const color = zone.color ?? ZONE_DEFAULT;
  const fill = zone.hollow ? undefined : color;
  const common = { fill, opacity: zone.hollow ? 1 : 0.45, stroke: color, strokeWidth: 5 };

  switch (zone.shape) {
    case "circle":
      return <Circle radius={zone.radius} {...common} />;

    case "donut":
      return <Ring innerRadius={zone.innerRadius} outerRadius={zone.radius} {...common} />;

    case "cone":
      // Konva wedges sweep clockwise from +x; rotate so the cone straddles north.
      return <Wedge radius={zone.radius} angle={zone.angle} rotation={-90 - zone.angle / 2} {...common} />;

    case "rect":
    case "line":
      return (
        <Rect x={-zone.width / 2} y={-zone.length / 2} width={zone.width} height={zone.length} {...common} />
      );

    case "knockback":
      return (
        <>
          <Rect x={-zone.width / 2} y={-zone.length / 2} width={zone.width} height={zone.length} {...common} />
          {[-1, 0, 1].map((i) => (
            <Arrow
              key={i}
              points={[i * zone.width * 0.3, zone.length / 2, i * zone.width * 0.3, -zone.length / 2]}
              stroke={color}
              fill={color}
              strokeWidth={6}
              pointerLength={22}
              pointerWidth={20}
            />
          ))}
        </>
      );

    case "arrow":
      return (
        <Arrow
          points={[0, zone.length / 2, 0, -zone.length / 2]}
          stroke={color}
          fill={color}
          strokeWidth={zone.width / 4}
          pointerLength={zone.width}
          pointerWidth={zone.width}
          opacity={0.9}
        />
      );

    case "triangle":
      return <RegularPolygon sides={3} radius={zone.radius} {...common} />;

    case "exaflare":
      return (
        <>
          {Array.from({ length: zone.count }, (_, i) => (
            <Circle
              key={i}
              y={-i * zone.radius * 2.1}
              radius={zone.radius}
              {...common}
              opacity={(zone.hollow ? 1 : 0.45) * (1 - i / (zone.count + 1))}
            />
          ))}
          <Arrow
            points={[0, zone.radius, 0, -zone.count * zone.radius * 2.1]}
            stroke={color}
            fill={color}
            strokeWidth={5}
            pointerLength={20}
            pointerWidth={18}
            opacity={0.8}
          />
        </>
      );

    case "stack":
      return (
        <>
          <Circle radius={zone.radius} {...common} />
          <Circle radius={zone.radius * 0.6} stroke={color} strokeWidth={6} dash={[18, 12]} />
          <Label text={`${zone.soak}`} size={zone.radius * 0.7} color="#0d1117" bold />
        </>
      );

    case "spread":
      return (
        <>
          <Circle radius={zone.radius} {...common} dash={[24, 16]} />
          <Line points={[-zone.radius, 0, zone.radius, 0]} stroke={color} strokeWidth={5} />
          <Line points={[0, -zone.radius, 0, zone.radius]} stroke={color} strokeWidth={5} />
        </>
      );

    case "tower":
      return (
        <>
          <Circle radius={zone.radius} {...common} />
          <Circle radius={zone.radius * 0.7} stroke={color} strokeWidth={8} />
          <Label text={`${zone.soak}`} size={zone.radius * 0.8} color="#0d1117" bold />
        </>
      );

    case "eye":
      return (
        <>
          <Ellipse radiusX={zone.radius} radiusY={zone.radius * 0.6} {...common} />
          <Circle radius={zone.radius * 0.28} fill="#0d1117" />
        </>
      );

    case "meteor":
      return (
        <>
          <Circle radius={zone.radius} {...common} />
          <Circle radius={zone.radius * 0.45} fill={color} opacity={0.9} />
        </>
      );

    case "proximity":
      return (
        <>
          <Circle radius={zone.radius} {...common} opacity={0.2} />
          <Circle radius={zone.radius * 0.66} fill={color} opacity={0.3} />
          <Circle radius={zone.radius * 0.33} fill={color} opacity={0.5} />
        </>
      );

    default:
      return <Circle radius={zone.radius} {...common} />;
  }
}

function Tether({
  entity,
  byId,
  selected,
  onSelect,
}: {
  entity: Extract<Entity, { type: "tether" }>;
  byId: Map<string, Entity>;
  selected: boolean;
  onSelect(id: string): void;
}) {
  const a = byId.get(entity.from);
  const b = byId.get(entity.to);
  if (!a || !b) return null;
  const color = entity.color ?? (entity.style === "far" ? "#e05252" : entity.style === "close" ? "#5aa8e0" : "#e0c452");
  const dash =
    entity.style === "minus" ? [26, 18] : entity.style === "chain" ? [8, 10] : undefined;
  return (
    <Fragment>
      <Line
        points={[a.x, a.y, b.x, b.y]}
        stroke={color}
        strokeWidth={selected ? entity.width * 1.6 : entity.width}
        dash={dash}
        opacity={entity.opacity}
        lineCap="round"
        onMouseDown={() => onSelect(entity.id)}
        hitStrokeWidth={30}
      />
      {(entity.style === "plus" || entity.style === "minus") && (
        <Label
          x={(a.x + b.x) / 2}
          y={(a.y + b.y) / 2}
          text={entity.style === "plus" ? "+" : "−"}
          size={70}
          color={color}
        />
      )}
    </Fragment>
  );
}

function Label({
  text,
  size,
  color,
  bold,
  x = 0,
  y = 0,
}: {
  text: string;
  size: number;
  color: string;
  bold?: boolean;
  x?: number;
  y?: number;
}) {
  return (
    <Text
      x={x}
      y={y}
      text={text}
      fontSize={size}
      fontStyle={bold ? "bold" : "normal"}
      width={600}
      offsetX={300}
      offsetY={size / 2}
      align="center"
      fill={color}
      listening={false}
    />
  );
}

/**
 * A centred bitmap. Renders `fallback` (the old vector token) until the art
 * loads, or forever if the URL is bad — the canvas never goes blank.
 */
function Sprite({
  src,
  width,
  height,
  opacity,
  fallback = null,
}: {
  src: string | undefined;
  width: number;
  height: number;
  opacity?: number;
  fallback?: React.ReactNode;
}) {
  const image = useImage(src);
  if (!image) return <>{fallback}</>;
  return (
    <KonvaImage
      image={image}
      width={width}
      height={height}
      offsetX={width / 2}
      offsetY={height / 2}
      opacity={opacity}
      listening={false}
    />
  );
}

/** Tiny local image loader, so the canvas needs no extra dependency. */
function useImage(src: string | undefined) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) return;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    img.onload = () => setImage(img);
    return () => {
      img.onload = null;
    };
  }, [src]);
  return image;
}
