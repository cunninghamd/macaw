const API_BASE = '/api';

let dailyChart = null;

async function fetchJSON(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

function formatCost(n) {
  const cost = n || 0;
  if (cost === 0) return '$0';
  if (cost < 0.01) return '$' + cost.toFixed(4);
  if (cost < 1) return '$' + cost.toFixed(2);
  return '$' + cost.toFixed(2);
}

function renderStats(containerId, data) {
  const container = document.getElementById(containerId);
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="stat-row"><span class="label">No data</span></div>';
    return;
  }
  container.innerHTML = data.map(row => {
    const tokens = (row.input_tokens || 0) + (row.output_tokens || 0);
    const cost = row.cost || 0;
    return `
    <div class="stat-row">
      <span class="label source-${row.source}">${row.source}</span>
      <span class="value">${formatNumber(tokens)} tokens${cost > 0 ? ' · ' + formatCost(cost) : ''}</span>
    </div>
  `}).join('');
}

async function loadSummary() {
  const data = await fetchJSON('/usage/summary');
  renderStats('today-stats', data.today);
  renderStats('week-stats', data.week);
  renderStats('alltime-stats', data.allTime);
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getDateRange(days) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return { start, end };
}

function generateDateList(start, end) {
  const dates = [];
  const curr = new Date(start);
  while (curr <= end) {
    dates.push(curr.toISOString().split('T')[0]);
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

async function loadDaily(days = 30) {
  const isAll = days === 0;
  const data = await fetchJSON(`/usage/daily?days=${isAll ? 0 : days}`);

  let allDates;
  let title;
  if (isAll) {
    if (data.length === 0) {
      allDates = [];
      title = 'Daily Usage (All Time)';
    } else {
      const dates = data.map(d => d.date).sort();
      const start = new Date(dates[0] + 'T00:00:00');
      const end = new Date(dates[dates.length - 1] + 'T00:00:00');
      allDates = generateDateList(start, end);
      title = 'Daily Usage (All Time)';
    }
  } else {
    const { start, end } = getDateRange(days);
    allDates = generateDateList(start, end);
    title = `Daily Usage (Last ${days} Days)`;
  }

  const inputData = allDates.map(date =>
    data.filter(d => d.date === date).reduce((sum, d) => sum + (d.input_tokens || 0), 0)
  );
  const outputData = allDates.map(date =>
    data.filter(d => d.date === date).reduce((sum, d) => sum + (d.output_tokens || 0), 0)
  );

  const labels = allDates.map(formatDateLabel);

  document.getElementById('chart-title').textContent = title;

  const ctx = document.getElementById('dailyChart');

  if (dailyChart) {
    dailyChart.destroy();
  }

  dailyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Input', data: inputData, backgroundColor: '#60a5fa' },
        { label: 'Output', data: outputData, backgroundColor: '#34d399' },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, grid: { color: '#334155' }, ticks: { color: '#94a3b8' } },
        y: { stacked: true, grid: { color: '#334155' }, ticks: { color: '#94a3b8' } },
      },
      plugins: {
        legend: { labels: { color: '#e2e8f0' } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              return allDates[idx];
            },
          },
        },
      },
    },
  });
}

async function loadSessions() {
  const data = await fetchJSON('/usage/sessions?limit=50');
  const tbody = document.querySelector('#sessions-table tbody');
  tbody.innerHTML = data.map(s => `
    <tr>
      <td>${s.project_path || '-'}</td>
      <td><span class="source-${s.source}">${s.source}</span></td>
      <td>${s.model || '-'}</td>
      <td>${formatNumber(s.input_tokens)}</td>
      <td>${formatNumber(s.output_tokens)}</td>
      <td>${formatNumber((s.cache_creation_tokens || 0) + (s.cache_read_tokens || 0))}</td>
      <td>${formatNumber(s.reasoning_tokens)}</td>
      <td>${s.cost > 0 ? formatCost(s.cost) : '-'}</td>
      <td>${s.last_timestamp ? new Date(s.last_timestamp).toLocaleDateString() : '-'}</td>
    </tr>
  `).join('');
}

async function loadProjects() {
  const data = await fetchJSON('/usage/projects');
  const tbody = document.querySelector('#projects-table tbody');
  tbody.innerHTML = data.map(p => `
    <tr>
      <td>${p.project_path}</td>
      <td><span class="source-${p.source}">${p.source}</span></td>
      <td>${p.session_count}</td>
      <td>${formatNumber(p.input_tokens)}</td>
      <td>${formatNumber(p.output_tokens)}</td>
      <td>${formatNumber((p.input_tokens || 0) + (p.output_tokens || 0))}</td>
      <td>${p.cost > 0 ? formatCost(p.cost) : '-'}</td>
    </tr>
  `).join('');
}

document.getElementById('ingest-btn').addEventListener('click', async () => {
  const btn = document.getElementById('ingest-btn');
  btn.textContent = '⏳ Ingesting...';
  btn.disabled = true;
  try {
    await fetch(`${API_BASE}/ingest`, { method: 'POST' });
    location.reload();
  } catch (e) {
    alert('Ingest failed: ' + e.message);
    btn.textContent = '🔄 Ingest Now';
    btn.disabled = false;
  }
});

document.querySelectorAll('.range-buttons button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-buttons button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const days = parseInt(btn.dataset.days, 10);
    loadDaily(days);
  });
});

async function loadAll() {
  await Promise.all([
    loadSummary(),
    loadDaily(30),
    loadSessions(),
    loadProjects(),
  ]);
}

loadAll();
