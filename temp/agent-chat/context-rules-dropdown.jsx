import { Button, Checkbox, Dropdown } from "antd";
import { FileTextOutlined } from "@ant-design/icons";

export default function ContextRulesDropdown({ rules, disabledIds, onToggle }) {
    const enabledCount = rules.length - disabledIds.size;

    const dropdownRender = () => (
        <div className="ai-chat-context-dropdown">
            {rules.map((rule) => (
                <label key={rule.id} className="ai-chat-context-dropdown-item">
                    <Checkbox
                        checked={!disabledIds.has(rule.id)}
                        onChange={() => onToggle(rule.id)}
                    />
                    <span>{rule.label}</span>
                </label>
            ))}
        </div>
    );

    return (
        <Dropdown
            trigger={["click"]}
            placement="topLeft"
            menu={{ items: [] }}
            popupRender={dropdownRender}
        >
            <Button
                size="small"
                shape="round"
                icon={<FileTextOutlined />}
                aria-label="Context rules"
                title="System context rules"
            >
                Rules {enabledCount}/{rules.length}
            </Button>
        </Dropdown>
    );
}
