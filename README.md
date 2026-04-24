# HRV Monitor — Coospo HW9

Dashboard de monitoramento de HRV em tempo real via Web Bluetooth, com protocolo clínico de reatividade autonômica e feedback sonoro guiado.

---

## Protocolo de Cálculo do RMSSD

### 1. Fonte do sinal

**Protocolo BLE:** Heart Rate Service (UUID `0x180D`), característica Heart Rate Measurement (UUID `0x2A37`), leitura por notificações GATT.

**Parsing do pacote:**
- Byte 0: flags — bit 0 = HR em 16 bits, bit 3 = energia presente, bit 4 = RR presente
- Extração dos intervalos RR: `uint16 little-endian` em unidades de **1/1024 s**, convertidos para ms por `rrMs = round(rrRaw × 1000 / 1024)`
- **Filtro de sanidade fisiológica:** apenas intervalos entre **260 ms e 2000 ms** são aceitos (30–230 bpm)

---

### 2. Detecção de artefatos de movimento (gap detection)

Executado a cada notificação BLE recebida, antes de processar o batch de RRs:

$$\text{gap} = t_{\text{notif}} - t_{\text{notif anterior}} - \sum_{i} RR_i$$

Se $\text{gap} > \max(350\,\text{ms},\ \hat{RR} \times 0{,}45)$, o dispositivo suprimiu batimentos:

$$n_{\text{missing}} = \text{round}\!\left(\frac{\text{gap}}{\hat{RR}}\right)$$

Onde $\hat{RR}$ é o último intervalo válido aceito (fallback: 800 ms). Os batimentos sintéticos são inseridos com `deviceFiltered = true` — registrados no tacograma para visualização, mas **nunca usados no cálculo do RMSSD**.

---

### 3. Filtro de anomalias (ectópicos / artefatos residuais)

Para cada novo batimento real (`deviceFiltered = false`):

$$\text{valid} = \frac{|RR_i - RR_{\text{ref}}|}{RR_{\text{ref}}} \leq \theta_{\text{anomaly}}$$

Onde $RR_{\text{ref}}$ é o último intervalo **aceito** e $\theta_{\text{anomaly}}$ é configurável (padrão: **50%**). O primeiro batimento da sessão é sempre aceito (`lastValidRR = null`). A referência só atualiza em batimentos válidos, evitando que um outlier aceite o próximo outlier.

---

### 4. Janela híbrida de cálculo

A amostra para o RMSSD é definida pela interseção de duas restrições:

| Critério | Valor padrão | Range configurável |
|---|---|---|
| **N batimentos válidos** | 30 | 5–300 |
| **Idade máxima** | 90 s | 10–600 s |

**`pruneWindow()`:** descarta do buffer `beats[]` todos os registros com `ts < now − windowMaxAgeMs`.

**`validRRs()`:** filtra `beats[]` por `valid = true`, depois retorna os **últimos N** via `.slice(-windowBeats)`.

Resultado: a amostra tem sempre tamanho fixo N (estável estatisticamente), exceto quando artefatos longos (> 90 s) esgotam o buffer — nesse caso retorna menos que N intervalos e o RMSSD retorna `--` quando `length < 2`.

---

### 5. Cálculo do RMSSD

$$\text{RMSSD} = \sqrt{\frac{1}{N-1} \sum_{i=1}^{N-1} (RR_i - RR_{i-1})^2}$$

Implementado sobre os N intervalos válidos consecutivos da janela. Executado a cada **3 segundos**. Retorna `null` se `N < 2`.

> **Nota:** o RMSSD é calculado sobre sucessões dentro da amostra filtrada — pares $(RR_i,\ RR_{i+1})$ onde ambos são válidos e adjacentes na janela. Batimentos `deviceFiltered` e anomalias interrompem a cadeia de sucessão, o que subestima levemente o RMSSD real em sessões com muitos artefatos intercalados. Isso é inerente ao método e comum a implementações de RMSSD de curto prazo com PPG.

---

### 6. Pipeline completo

```
BLE notification
  └─ onHRMeasurement()
       ├─ parse flags + RRs (1/1024 s → ms)
       ├─ sanity filter (260–2000 ms)
       ├─ gap detection → processBeat(estRR, syntheticTs, deviceFiltered=true)
       └─ processBeat(rr)
            ├─ isValidBeat() → filtro anomalia θ
            ├─ beats.push({ rr, ts, valid, deviceFiltered })
            ├─ pruneWindow() → descarta beats com ts < now − 90 s
            └─ [a cada 3 s] updateMetrics()
                  ├─ validRRs() → últimos 30 válidos
                  ├─ calcRMSSD() → √(Σd²/(N−1))
                  └─ calcStress() → mapeamento linear RMSSD ∈ [15, 100] → stress ∈ [10, 1]
```

---

## Protocolo Sonoro Clínico

Protocolo de reatividade autonômica com 8 fases sequenciais e feedback sonoro guiado. Iniciado manualmente via botão **Protocolo Sonoro**.

### Fases

| # | Nome | Áudio | Duração padrão |
|---|---|---|---|
| 0 | Linha de Base | silêncio | 90 s |
| 1 | Guia Respiratório 1 | `inspira.mp3` / `expira.mp3` (ciclo IN/OUT) | 60 s |
| 2 | Silêncio pré-estressor | silêncio | 2 s (fixo) |
| 3 | Estressor | `sirene.mp3` (fade-in + fade-out) | 5 s |
| 4 | Silêncio pós-estressor | silêncio | 2 s (fixo) |
| 5 | Guia Respiratório 2 | `inspira.mp3` / `expira.mp3` (ciclo IN/OUT) | 60 s |
| 6 | Movimentação | `move.mp3` (fade-in + fade-out) | 10 s |
| 7 | Repouso | silêncio | 10 s |

- **Guia respiratório:** ciclo IN/OUT com proporção 50/50, cadência configurável em incursões por minuto (padrão: 6 inc/min = 5 s IN / 5 s OUT)
- **Fade:** duração de 800 ms tanto na entrada quanto na saída dos sons de estressor e movimentação
- As fases de silêncio (índices 2 e 4) têm duração fixa de 2 s e não são configuráveis

### Arquivos de áudio necessários

Colocar na raiz do projeto:

```
inspira.mp3
expira.mp3
sirene.mp3
move.mp3
```

---

## Qualidade do Sinal (SQI)

Calculado a cada **30 segundos** como a proporção de batimentos válidos sobre o total recebido no período:

$$\text{SQI} = \frac{n_{\text{válidos}}}{n_{\text{total}}} \times 100\%$$

| Faixa | Estado |
|---|---|
| ≥ 85% | Normal |
| 70–84% | Aviso |
| < 70% | Crítico |

---

## Configurações

| Parâmetro | Padrão | Range | Descrição |
|---|---|---|---|
| Batimentos na Janela | 30 | 5–300 | Número fixo de RR válidos para o RMSSD |
| Idade Máxima | 90 s | 10–600 s | Descarte de beats mais antigos que este limite |
| Filtro de Anomalias | 50% | 5–80% | Desvio máximo tolerado por batimento |

Editáveis em tempo real via botão **Alterar** no painel superior.

---

## Exportação

O botão **Exportar CSV** gera um arquivo JSON com:

- `config`: parâmetros vigentes no momento da exportação (`janela_batimentos`, `janela_maxage_s`, `filtro_anomalias_pct`)
- `beats`: série completa de intervalos RR com timestamp, valor em ms e flag de validade
- `metricas`: série histórica de HR, RMSSD e Stress a cada 3 s
