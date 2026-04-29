import { useEffect, useState } from "react";
import {
  DeleteOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
  ToolOutlined
} from "@ant-design/icons";
import {
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tabs
} from "antd";

const { TextArea } = Input;

export function SettingsPanel(props) {
  const [draftMaxTurns, setDraftMaxTurns] = useState(props.maxTurns);
  const [draftMaxConcurrentRuns, setDraftMaxConcurrentRuns] = useState(props.maxConcurrentRuns);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  useEffect(() => {
    setDraftMaxTurns(props.maxTurns);
  }, [props.maxTurns]);

  useEffect(() => {
    setDraftMaxConcurrentRuns(props.maxConcurrentRuns);
  }, [props.maxConcurrentRuns]);

  const canSaveSettings =
    Number.isInteger(draftMaxTurns) &&
    draftMaxTurns >= 1 &&
    draftMaxTurns <= 200 &&
    Number.isInteger(draftMaxConcurrentRuns) &&
    draftMaxConcurrentRuns >= 1 &&
    draftMaxConcurrentRuns <= 64;

  function submitSettings(event) {
    event.preventDefault();
    if (!canSaveSettings || isSavingSettings) return;
    setIsSavingSettings(true);
    Promise.resolve(props.onSubmitSettings?.({
      maxTurns: draftMaxTurns,
      maxConcurrentRuns: draftMaxConcurrentRuns
    }))
      .catch(() => {})
      .finally(() => setIsSavingSettings(false));
  }

  const tabItems = [
    {
      key: "settings",
      label: (
        <span className="ai-chat-tool-label">
          <SettingOutlined /> Settings
        </span>
      ),
      children: (
        <form className="ai-chat-tool-panel" onSubmit={submitSettings}>
          {props.rootInfo ? (
            <div className="ai-chat-root-info">
              <span>Project root</span>
              <code title={props.rootInfo.projectRoot}>{props.rootInfo.projectRoot}</code>
              <span>Claude commands</span>
              <code title={props.rootInfo.claudeCommandsDir}>{props.rootInfo.claudeCommandsDir}</code>
            </div>
          ) : null}
          <label className="ai-chat-field">
            <span>Max turns</span>
            <InputNumber
              size="small"
              min={1}
              max={200}
              value={draftMaxTurns}
              onChange={(value) => setDraftMaxTurns(value)}
              style={{ width: "100%" }}
            />
          </label>
          <label className="ai-chat-field" title="Maximum sessions running in parallel on the server">
            <span>Concurrent runs</span>
            <InputNumber
              size="small"
              min={1}
              max={64}
              value={draftMaxConcurrentRuns ?? null}
              onChange={(value) => setDraftMaxConcurrentRuns(value)}
              style={{ width: "100%" }}
            />
          </label>
          <Button
            size="small"
            type="primary"
            htmlType="submit"
            icon={<SendOutlined />}
            loading={isSavingSettings}
            disabled={!canSaveSettings}
          >
            Save settings
          </Button>
        </form>
      )
    },
    {
      key: "commands",
      label: (
        <span className="ai-chat-tool-label">
          <ToolOutlined /> Claude Commands
        </span>
      ),
      children: (
        <Form layout="vertical" size="small" component="div" className="ai-chat-tool-panel ai-chat-tool-form">
          <p className="ai-chat-tool-hint">{props.commandsHint}</p>
          <Form.Item label="Commands">
            <Select
              size="small"
              className="ai-chat-settings-select"
              popupClassName="ai-chat-settings-select-popup"
              value={props.selectedCommandPath || undefined}
              placeholder={props.commandOptions.length > 0 ? "Choose a command" : "No commands saved"}
              notFoundContent="No commands saved"
              options={props.commandOptions}
              style={{ width: "100%" }}
              allowClear
              showSearch
              optionFilterProp="label"
              onChange={(value) => {
                const nextValue = value || "";
                props.setSelectedCommandPath(nextValue);
                nextValue ? props.loadClaudeCommand(nextValue) : props.clearCommandEditor();
              }}
            />
          </Form.Item>
          <Form.Item label="Command path">
            <Input
              size="small"
              value={props.commandPath}
              placeholder="review/fix.md"
              onChange={(event) => props.setCommandPath(event.target.value)}
            />
          </Form.Item>
          <Form.Item label="Command content">
            <TextArea
              size="small"
              rows={5}
              value={props.commandContent}
              placeholder="Write the Claude slash command markdown here."
              onChange={(event) => props.setCommandContent(event.target.value)}
            />
          </Form.Item>
          <Space size={8} wrap className="ai-chat-tool-actions">
            <Button size="small" type="primary" onClick={props.saveCommand}>
              Save
            </Button>
            <Button size="small" onClick={props.clearCommandEditor}>
              New
            </Button>
            <Button
              size="small"
              icon={<DeleteOutlined />}
              danger
              onClick={props.deleteCommand}
            >
              Delete
            </Button>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => props.loadClaudeCommands()}
            >
              Refresh
            </Button>
          </Space>
        </Form>
      )
    },
  ];

  return (
    <div className="ai-chat-settings-panel">
      <Tabs
        defaultActiveKey="settings"
        items={tabItems}
        className="ai-chat-settings-tabs"
        size="small"
      />
    </div>
  );
}

export function SidebarSettingsButton({ isActive, onClick }) {
  return (
    <div className="ai-chat-sidebar-footer">
      <button
        type="button"
        className={["ai-chat-sidebar-footer-button", isActive ? "is-active" : ""].filter(Boolean).join(" ")}
        onClick={onClick}
      >
        <SettingOutlined />
        Settings
      </button>
    </div>
  );
}
