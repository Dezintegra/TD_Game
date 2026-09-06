## ADDED Requirements

### Requirement: Модель определяется назначенным этапом

Супервизор SHALL выбирать модель из stageModels выбранного провайдера:
сначала ключ этапа, затем default, затем прежнее stageModel или codexModel.
Без настроенной модели ключ --model SHALL отсутствовать.

#### Scenario: Новая сессия и продолжение

- **WHEN** запускается этап или его продолжение
- **THEN** обе формы получают одну явно выбранную по этапу модель
- **AND** карта другого провайдера не влияет на выбор

#### Scenario: Совместимость

- **WHEN** карты нет или в ней нет этапа и default
- **THEN** используется прежняя общая модель выбранного провайдера

### Requirement: Распределение моделей TD Game

Проект SHALL назначать triage, interpret, postmortem моделям gpt-6-astra
и claude-fable-5-1; implement, revise, benchmark, deploy — gpt-5.6-terra
и claude-opus-4-8; остальные этапы — gpt-5.6-sol и claude-opus-5.
Общие инструкции SHALL закреплять Astra/Fable только для анализа ошибок,
неисправностей, толкования результатов и постановки кандидатов, Terra/Opus 4.8
для кода, MR/PR, выкладки и её валидации, Sol/Opus 5 для остальных задач.

#### Scenario: Выкладка и готовность среды

- **WHEN** запускается deploy или проверка готовности среды Codex
- **THEN** используется модель исполнения, включая штатную валидацию выкладки

#### Scenario: Остальные работы

- **WHEN** запускается design, audit, review, decompose или новый этап
- **THEN** используется Sol для Codex либо Opus 5 для Claude

#### Scenario: Разбор и постановка

- **WHEN** запускается triage, interpret или postmortem
- **THEN** используется Astra для Codex либо Fable 5.1 для Claude
