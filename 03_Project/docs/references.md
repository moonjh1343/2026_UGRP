# 참고문헌

[paper-outline.md](paper-outline.md) 2장(관련 연구)의 재료. PDF 원본은 `02_참고 논문/`(gitignore)에 있으며
★ 표시가 보유본이다. 마지막 조사: 2026-08-15.

**관련연구 절에서 주장할 공백:** 어느 문헌도 (a) 5개 렌더링 모드를 한 SUT에서 (b) 디바이스×네트워크×서버 부하
격자로 측정하고 (c) 서로게이트 회귀+argmin 정책을 학습해 (d) 엣지에서 <2ms로 서빙하는 조합을 다루지 않는다.
가장 가까운 것은 US 10,764,403(규칙 기반)과 MRAH(하이드레이션 순서)이며 둘 다 서버 부하 축과 학습이 없다 —
이 두 편을 정면 비교 대상으로 둔다.

## A. 조건 적응형 렌더링·하이드레이션 (§2.2 — 가장 가까운 연구)

| 문헌 | 관련성 | 차이점(우리 기여 지점) |
|---|---|---|
| ★ MRAH — Improving Front-end Performance through Modular Rendering and Adaptive Hydration in React (arXiv 2504.03884, 2025) <https://arxiv.org/abs/2504.03884> | 디바이스·네트워크·컴포넌트 중요도로 하이드레이션 우선/지연 | 규칙 기반, 모드 선택이 아닌 하이드레이션 순서, 학습 없음 |
| ★ Predictive Angular Rendering: ML Models for Intelligent Client-Side Optimization with Adaptive Backend Coordination | 클라이언트 렌더링 최적화에 ML 적용 | 단일 프레임워크, 서버 부하 축 없음 |
| ★ An Adaptive Rendering and Data Orchestration Model for High-Scale Mobile and Web Application Platforms | 적응형 렌더링 모델 | 조건별 측정·정책 학습 없음 |
| Adaptive Loading — Osmani & Schloss, Chrome Dev Summit 2019 <https://web.dev/articles/adaptive-loading-cds-2019>, <https://github.com/GoogleChromeLabs/react-adaptive-hooks> | Network Information API·Device Memory·Client Hints로 경험 차등 제공 — 특징 벡터의 원형 | 클라이언트 휴리스틱, 서버 부하 축 없음, 렌더링 모드 고정 |
| US Patent 10,764,403 — Client configuration and utilization-aware adaptive server-side rendering <https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10764403> | 클라이언트 자원·서버 이용률로 SSR 여부 결정 — 문제 설정이 거의 동일 | 규칙 기반, 학습·평가 없음. **선행기술로 반드시 인용** |
| Energy-aware Web Browsing on Heterogeneous Mobile Platforms (arXiv 1710.03559) <https://arxiv.org/pdf/1710.03559> | 회귀로 로드 시간·에너지 예측 후 렌더링 위치 결정 — "예측 → argmin" 구조 동일 | big.LITTLE 코어 선택, 웹 렌더링 모드 아님 |
| The Rise of Disappearing Frameworks in Web Development (arXiv 2304.01947) <https://arxiv.org/pdf/2304.01947> | Islands/resumability 계보 정리 | 측정·정책 없음 |

## B. CSR vs SSR 정적 비교 (§2.1 — RQ1 divergence의 배경)

- ★ Client-Side vs Server-Side Rendering Impacts on Performance
- ★ Comparisons of Server-side (rendering)
- ★ IJAIBDCMS-V7I1P112
- ★ 서버 사이드 렌더링과 스트리밍 서버 사이드 렌더링 간 성능 분석을 기반으로 한 Hydration 연구 (국내)
- Iskandar et al., Comparison between client-side and server-side rendering in the web development, IOP MSE 801 (2020) <https://iopscience.iop.org/article/10.1088/1757-899X/801/1/012136>
- Teknika (Mar 2024) — Next.js 기반 Filmku 사이트의 CSR/SSR/SSG 로딩 시간 비교 <https://doaj.org/article/ee817689ead843eaadb0a8edc1d8e40d>

공통 한계: 단일 조건에서 측정, 조건별 우열 역전을 다루지 않음.

## C. 페이지 로드 최적화 시스템 (§4 시스템 설계 비교군)

- Netravali et al., Polaris: Faster Page Loads Using Fine-grained Dependency Tracking, NSDI '16
- Netravali & Mickens, Prophecy: Accelerating Mobile Page Loads Using Final-state Write Logs, NSDI '18
- Netravali et al., Vesper: Measuring Time-to-Interactivity for Web Pages, NSDI '18 <https://dl.acm.org/doi/10.5555/3307441.3307461> — QoE 지표(상호작용 가능 시점) 정의 근거
- Wang et al., Speeding up Web Page Loads with Shandian, NSDI '16 <https://www.usenix.org/system/files/conference/nsdi16/nsdi16-paper-wang-xiao-sophia.pdf> — SSR/Streaming의 시스템적 원형
- Butkiewicz et al., Klotski: Reprioritizing Web Content to Improve User Experience on Mobile Devices, NSDI '15
- Kelton et al., Improving User Perceived Page Load Times Using Gaze (WebGaze), NSDI '17 <https://www.usenix.org/system/files/conference/nsdi17/nsdi17-kelton.pdf>
- JSAnalyzer: A Web Developer Tool for Simplifying Mobile Pages Through JavaScript Optimizations (arXiv 2106.14093) <https://arxiv.org/pdf/2106.14093>

## D. 웹 성능 예측 ML (§3.4 서로게이트 회귀 근거)

- An empirical comparison of predictive models for web page performance, Information and Software Technology (2020) <https://www.sciencedirect.com/science/article/abs/pii/S0950584920300598> — 선형회귀·SVM·MLP·RF 비교; LightGBM 선택 정당화
- Predicting Website Performance: A Systematic Review of Metrics, Methods, and Research Gaps (2010–2024), Computers 14(10):446 (2025) <https://doi.org/10.3390/computers14100446> — 59개 특징 정리, 특징 선택 근거
- WebProphet: Automating Performance Prediction for Web Services, NSDI '10 <https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/webprophet.pdf>
- A Novel Approach for Evaluating Web Page Performance Based on ML and Optimization Algorithms, AI 6(2):19 (2025) <https://doi.org/10.3390/ai6020019>

## E. 학습 기반 구성 선택 · 제약 최적화 · 오프폴리시 평가 (§3, §7.5 방법론 근거)

- Mao et al., Neural Adaptive Video Streaming with Pensieve, SIGCOMM '17 <https://people.csail.mit.edu/hongzi/content/publications/Pensieve-Sigcomm17.pdf> — 런타임 컨텍스트로 전송 정책 학습; QoE 목적함수 설계 참고
- Alipourfard et al., CherryPick: Adaptively Unearthing the Best Cloud Configurations for Big Data Analytics, NSDI '17 <https://www.usenix.org/system/files/conference/nsdi17/nsdi17-alipourfard.pdf>
- Hsu et al., Scout: An Experienced Guide to Find the Best Cloud Configuration (arXiv 1803.01296) <https://arxiv.org/pdf/1803.01296>
- Hsu et al., Micky: A Cheaper Alternative for Selecting Cloud Instances (arXiv 1803.05587) <https://arxiv.org/pdf/1803.05587>
  — 위 셋: 성능 모델로 "충분히 좋은 구성"을 고르는 계열; top-1/top-2 마진 논리와 통함
- US Patent 11,983,574 — Workload optimization through contextual bandits <https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11983574> — 밴딧 확장 선행기술
- Li et al., Unbiased Offline Evaluation of Contextual-bandit-based News Article Recommendation Algorithms, WSDM '11 (arXiv 1003.5956)
- Dudík et al., Doubly Robust Policy Evaluation and Learning, ICML '11 (arXiv 1103.4601)
- Swaminathan & Joachims, Counterfactual Risk Minimization, ICML '15
  — 위 셋: 필드 무작위화·성향 로깅 설계의 근거
