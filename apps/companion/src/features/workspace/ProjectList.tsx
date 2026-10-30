import { Badge, Box, Button, Card, Column, Icon, Pressable, Row, Text, type ColorToken } from '@pi-lead-child/components';
import type { ProjectOverview } from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { buildProjectCards, type ProjectCardView, type ProjectCountKey } from './projectModel';
import { UNASSIGNED_PROJECT } from './model';

const palette: ColorToken[] = ['accent', 'warning', 'success', 'danger', 'violet', 'cyan'];

// 项目名决定色块颜色：同一个项目在哪里都是同一种颜色。unknown 是未归属工单，用灰色。
function projectColor(name: string): ColorToken {
  const hash = [...name].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  return name === UNASSIGNED_PROJECT ? 'text-muted' : palette[hash % palette.length]!;
}

// 分布条和图例的颜色，和工单 tab 的分组颜色一致。
const countColor: Record<ProjectCountKey, ColorToken> = {
  user: 'danger',
  running: 'accent',
  lead: 'violet',
  queued: 'text-muted',
  ended: 'success-line',
};

type ProjectListProps = {
  overviews: readonly ProjectOverview[] | null;
  /** 点一个项目：工单 tab 只列这个项目的工单。参数是服务端的项目名。 */
  onSelect?: (name: string) => void;
  onSetArchived?: (projectId: number, archived: boolean) => Promise<void>;
};

function SectionTitle({ label, count }: { label: string; count: number }) {
  return (
    <Row items="center" gap="inline-item" px="section-label-x" pt="section-label-top" pb="section-label-bottom">
      <Text size="eyebrow" weight="extrabold" letterSpacing={0.3} color="text-strong">{label}</Text>
      <Text size="meta" weight="bold" tone="muted">{String(count)}</Text>
    </Row>
  );
}

// 在推进的项目：一项目一卡。分布条、图例、Lead 写的一句话、最近的截止、累计花费。
function ProjectCard({ card, onSelect }: { card: ProjectCardView; onSelect?: (name: string) => void }) {
  return (
    <Pressable
      testID={`project-row-${card.id}`}
      onPress={onSelect ? () => onSelect(card.projectName) : undefined}
      feedback="opacity"
      bg="surface"
      rounded="xl"
      borderWidth={1}
      borderColor="border"
      p="card"
      gap="card-row"
    >
      <Row items="center" gap="icon-label">
        <Box w={10} h={10} rounded={3} bg={projectColor(card.projectName)} />
        <Text flex={1} minW={0} size="card-title" weight="extrabold" numberOfLines={1}>{card.name}</Text>
        {card.leadLine ? <Text size="meta" mono weight="bold" tone="muted">{card.leadLine.when}</Text> : null}
      </Row>
      {/* spacing-exempt: 分布条分段间隙 */}
      <Row h={5} gap={2} rounded="full" overflow="hidden">
        {card.legend.map((entry) => <Box key={entry.key} flex={entry.count} bg={countColor[entry.key]} />)}
      </Row>
      <Row gap="chips" flexWrap="wrap">
        {card.legend.map((entry) => (
          <Row key={entry.key} items="center" gap="icon-label">
            <Box w={6} h={6} rounded="full" bg={countColor[entry.key]} />
            <Text size="meta" tone="secondary">{`${entry.label} ${entry.count}`}</Text>
          </Row>
        ))}
      </Row>
      {card.leadLine ? (
        <Row gap="side-item" items="flex-start">
          {/* spacing-exempt: 光学对齐 */}
          <Box w={16} h={16} mt={1} rounded={4} bg="text" center>
            {/* spacing-exempt: 文字当图标用 */}
            <Text size="9" mono weight="bold" color="surface">π</Text>
          </Box>
          <Text flex={1} minW={0} size="body" tone="strong" numberOfLines={3}>{card.leadLine.text}</Text>
        </Row>
      ) : null}
      {card.stale || card.nextMilestone || card.spend ? (
        <Row items="center" gap="chips" flexWrap="wrap">
          {card.stale ? <Badge label={card.stale} tone="gray" size="sm" /> : null}
          {card.nextMilestone ? <Badge label={card.nextMilestone} tone={card.nextMilestoneOverdue ? 'danger' : 'warning'} size="sm" /> : null}
          <Box flex={1} />
          {card.spend ? (
            <Row items="baseline" gap="inline-item">
              <Text size="meta" mono weight="bold">{card.spend}</Text>
              <Text size="meta" tone="muted">累计</Text>
            </Row>
          ) : null}
        </Row>
      ) : null}
    </Pressable>
  );
}

// 收起的项目（安静的、已归档的）：一行名字和数字，右边是归档或恢复。
function FoldedRow({ card, action, onSelect }: {
  card: ProjectCardView;
  action: { testID: string; label: string; onPress: () => void } | null;
  onSelect?: (name: string) => void;
}) {
  return (
    <Row items="center" gap="side-item" pr="row-x">
      <Pressable
        testID={`project-row-${card.id}`}
        onPress={onSelect ? () => onSelect(card.projectName) : undefined}
        feedback="highlight"
        flex={1}
        minW={0}
        px="row-x"
        py="row-y"
        rounded="md"
      >
        <Row items="center" gap="side-item">
          <Box w={8} h={8} rounded={2} bg={projectColor(card.projectName)} />
          <Column flex={1} minW={0}>
            <Text size="card-title" weight="bold" numberOfLines={1}>{card.name}</Text>
            <Text size="secondary" tone="muted" numberOfLines={1}>{card.caption}</Text>
          </Column>
        </Row>
      </Pressable>
      {action ? <Button testID={action.testID} label={action.label} variant="outline" tone="neutral" size="xs" onPress={action.onPress} /> : null}
    </Row>
  );
}

function Fold({ testID, label, cards, open, onToggle, children }: {
  testID: string;
  label: string;
  cards: ProjectCardView[];
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    // spacing-exempt: 行自带内边距
    <Card rounded="xl" p={2} gap={0}>
      <Pressable testID={testID} aria-expanded={open} onPress={onToggle} feedback="highlight" px="row-x" py="row-y" rounded="md">
        <Row items="center" gap="inline-item">
          <Text size="card-title" weight="bold">{`${label} ${cards.length}`}</Text>
          <Text flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>{cards.map((card) => card.name).join('、')}</Text>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} color="text-muted" size={12} />
        </Row>
      </Pressable>
      {open ? children : null}
    </Card>
  );
}

// 项目 tab（阶段 2，方向 A）。有未结束工单的项目一项目一卡，等你的在前；没有未结束工单的收进「安静的项目」，
// 可以归档；归档的收进「已归档」，可以恢复。
export function ProjectList({ overviews, onSelect, onSetArchived }: ProjectListProps) {
  const [quietOpen, setQuietOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (overviews === null) {
    return (
      <Column testID="project-list" px="section-label-x" py="banner-y">
        <Text size="secondary" tone="muted">正在读取项目</Text>
      </Column>
    );
  }

  const cards = buildProjectCards(overviews);
  const setArchived = (card: ProjectCardView, archived: boolean) => {
    setError(null);
    void onSetArchived?.(Number(card.id), archived).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <Column testID="project-list" gap="stacked-card" w="100%">
      <SectionTitle label="在推进" count={cards.active.length} />
      {cards.active.length === 0 ? (
        <Card rounded="xl" p="card">
          <Text size="secondary" tone="secondary">没有在推进的项目。</Text>
        </Card>
      ) : null}
      {cards.active.map((card) => <ProjectCard key={card.id} card={card} onSelect={onSelect} />)}
      {error ? <Text size="secondary" color="danger-dark" px="section-label-x">{error}</Text> : null}
      {cards.quiet.length > 0 ? (
        <Fold testID="projects-quiet" label="安静的项目" cards={cards.quiet} open={quietOpen} onToggle={() => setQuietOpen((open) => !open)}>
          {cards.quiet.map((card) => (
            <FoldedRow
              key={card.id}
              card={card}
              onSelect={onSelect}
              action={card.canArchive && onSetArchived
                ? { testID: `project-archive-${card.id}`, label: '归档', onPress: () => setArchived(card, true) }
                : null}
            />
          ))}
        </Fold>
      ) : null}
      {cards.archived.length > 0 ? (
        <Fold testID="projects-archived" label="已归档" cards={cards.archived} open={archivedOpen} onToggle={() => setArchivedOpen((open) => !open)}>
          {cards.archived.map((card) => (
            <FoldedRow
              key={card.id}
              card={card}
              onSelect={onSelect}
              action={onSetArchived
                ? { testID: `project-restore-${card.id}`, label: '恢复', onPress: () => setArchived(card, false) }
                : null}
            />
          ))}
        </Fold>
      ) : null}
    </Column>
  );
}
