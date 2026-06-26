# RIO MOST WANTED — Linha Amarela

Jogo de corrida arcade no estilo **Need for Speed Most Wanted (PS2)** ambientado no
**Rio de Janeiro**, com uma malha real de vias (OSM) ligando **sete terminais**:
**Penedo (Itatiaia)**, **Muriqui (Mangaratiba)**, **Recreio dos Bandeirantes**,
**Jardim Oceânico**, **Rio 2 (Barra Olímpica)**, **Norte Shopping** e
**Ilha do Fundão (UFRJ)** — 42 rotas direcionais reais (cada sentido usa a pista
correta):

- Recreio ↔ Fundão (~36–39 km): orla da Barra → Av. Ayrton Senna → **Linha
  Amarela inteira** (túneis, pedágio LAMSA, 10 saídas numeradas) → Fundão.
- Jardim Oceânico ↔ Fundão (~29–30 km): **Elevado do Joá → Zona Sul → Rebouças →
  Linha Vermelha elevada** — rota alternativa real pelo centro.
- Recreio ↔ Jardim Oceânico (~17–18 km): a orla inteira da Barra, **com a praia,
  a arrebentação, o mar e os coqueiros do calçadão no lado sul**.
- Muriqui ↔ qualquer terminal (65–103 km): Costa Verde pela Rio-Santos/RJ-014,
  Túnel da Grota Funda e Guaratiba.
- Penedo ↔ qualquer terminal (~145–176 km): **Via Dutra (BR-116)** pelo Vale do
  Paraíba (Volta Redonda, Resende) até a Serra da Mantiqueira — as rotas mais
  longas do jogo.

**Mão dupla real**: trechos bidirecionais (orla, Rio-Santos) têm o nº exato de
faixas por sentido do OSM (ex.: orla com 2 faixas → Recreio e 1 → Barra, coladas,
divisor duplo amarelo) e **tráfego vindo na contramão** — dá para ultrapassar
invadindo a contramão, por sua conta e risco. Pontes, alças e elevados sobem de
verdade. Largada/chegada: terminais ou pontos intermediários (Praia da Barra,
Cebolão, Pedágio).

## Escolhas antes de correr

- **Carro** (↔ no menu): Fiat Uno Mille, Renault Kwid, VW Gol GTI, Chevrolet
  Opala SS, Honda Civic Si, BMW M3 GTR e Porsche 911 Turbo — cada um com
  velocidade, aceleração e aderência próprias (carros lentos ganham mais tempo
  por checkpoint).
- **Trânsito**: LEVE (14), MÉDIO (32), PESADO (55) ou CAÓTICO (80 carros) — a
  densidade varia ao longo da via, os carros mudam de faixa e congestionam de
  verdade perto do pedágio.
- **Polícia** e **Dificuldade** (PASSEIO a MOST WANTED) também escolhidos no menu.
- **Leaderboard por cenário**: cada combinação carro + trânsito + trajeto +
  polícia + dificuldade tem seu próprio top 5, salvo no navegador; ao vencer com
  tempo top 5, digite seu nome.

## Fidelidade da via

- O nº de faixas muda ao longo do percurso conforme o OSM real (2 a 5 faixas):
  a pista alarga e estreita, com tracejado em cada divisa real.
- Pórticos verdes ao longo do caminho listam os próximos bairros e distâncias
  ("Gardênia Azul 3,2 km · Cidade de Deus 3,9 km · Ilha do Fundão 21 km").
- Viadutos do entorno são elevados com pilares — nunca sobre a pista jogável.

## Como jogar

**Duplo clique em `jogar.bat`** (requer Python instalado). Ele sobe um servidor
local e abre o jogo no navegador.

Alternativa manual:

```
python -m http.server 8123
# abra http://localhost:8123/index.html
```

> Abrir o `index.html` direto (file://) não funciona — módulos ES exigem servidor.
> É preciso internet na primeira vez (Three.js vem de CDN).

## Controles

| Tecla | Ação |
|---|---|
| W / ↑ | acelerar |
| S / ↓ | frear / ré |
| A D / ← → | direção |
| SHIFT | nitro — arma a partir de 50% da carga; uma vez armado, usa até o fim |
| ESPAÇO | freio de mão (drift) |
| C | alternar câmera |
| M | som liga/desliga |
| P | pausa |
| R | reiniciar corrida |

A barra de nitro mostra o estado: **cinza** = carregando (abaixo de 50%, não dá
para usar), **verde** = carregado (pronto para armar) e **azul** = em uso. Ele só
**arma** ao atingir a marca de 50%; depois você usa até esvaziar (mesmo abaixo de
50%) e, ao soltar ou esvaziar, recarrega sempre. Isso premia rajadas bem
cronometradas nas retas em vez de segurar o boost o tempo todo.

## Objetivo

Corrida contra o relógio com tempo **calibrado por simulação**: o jogo calcula
o tempo ideal do SEU carro em CADA trecho (curvas fechadas e fluxo de tráfego
contam) e dá uma folga conforme a **dificuldade** — PASSEIO (sem contra-relógio),
FÁCIL (+55%), NORMAL (+32%), DIFÍCIL (+16%) ou MOST WANTED (+4%). Um Uno e um
Porsche recebem relógios diferentes, e trechos sinuosos valem mais tempo.
O tráfego tem **carros e motos**: as motos são mais rápidas e costuram pelo
corredor entre as faixas — cuidado ao mudar de faixa.
**Batida forte capota o outro carro, te deixa atordoado — e chama a POLÍCIA**:
as viaturas são **pilotos perfeitos num carro igual ao seu, sem nitro** (freiam
nas curvas no traçado ideal), com velocidade-teto igual à sua no MOST WANTED e
gradualmente mais lentas nos níveis fáceis. Elas nascem bem atrás (dando tempo de
se recuperar da batida), e a distância é pura física: **só o nitro em estiradas
longas abre vantagem**; bater de novo ou frear à toa cola a polícia de volta.
Fuja o suficiente e elas desistem; deixe-as encostar e te cercam — você é preso.
Dá para desligar a polícia no menu. Ultrapassar **pelo
acostamento** faz o carro perder velocidade na zebra — use as faixas.
Vença um cenário e o seu melhor tempo vira uma **sombra (ghost)** translúcida
que corre contra você nas próximas tentativas. O leaderboard top 5 é separado
por carro + trânsito + trajeto + polícia + dificuldade.

## Contexto real (dados OSM)

- O HUD mostra o **bairro real** por onde você está passando (Cidade de Deus,
  Freguesia, Água Santa, Cachambi, Bonsucesso...) e o nome oficial dos túneis
  (Túnel Eng. Raymundo de Paula Soares, o "Túnel da Covanca").
- O minimapa exibe os bairros do entorno.
- As **10 saídas reais** da via aparecem como aberturas no guard-rail com
  barreiras listradas (não dá para sair) e **placas verdes** 280 m antes
  ("SAÍDA 03 · Meier", "SAÍDA 04 · Engenho de Dentro"...), com destinos
  extraídos das tags de `destination` do OSM.

## Arquivos

- `index.html` / `game.js` — o jogo (Three.js)
- `map_data.js` — geometria real processada (rota + vias + túneis)
- `process_map.py` — regenera `map_data.js` a partir dos dados OSM brutos
- `linha_amarela_raw.json` / `roads_raw.json` — dados brutos da Overpass API

## Versão e leaderboards

A versão da mecânica aparece no rodapé do menu (ex.: `build POL-9.3`). Cada
mudança de funcionamento que afete os tempos bumpa essa versão e **reseta
automaticamente** os leaderboards e ghosts (tempos de versões diferentes não são
comparáveis). O jogo carrega sempre a versão fresca (cache-busting), então basta
recarregar a página após uma atualização.

Dados de mapa © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).
